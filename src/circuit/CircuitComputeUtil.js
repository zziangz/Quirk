import {CircuitEvalArgs} from "src/circuit/CircuitEvalArgs.js"
import {KetTextureUtil} from "src/circuit/KetTextureUtil.js"
import {Controls} from "src/circuit/Controls.js"
import {Gate} from "src/circuit/Gate.js"
import {Gates} from "src/gates/AllGates.js"
import {Point} from "src/math/Point.js"
import {Util} from "src/base/Util.js"
import {seq, Seq} from "src/base/Seq.js"
import {notifyAboutRecoveryFromUnexpectedError} from "src/fallback.js"

/**
 * @param {!CircuitDefinition} circuitDefinition
 * @param {!string=""} symbol
 * @param {!string=""} name
 * @param {!string=""} blurb
 * @returns {!Gate}
 */
function circuitDefinitionToGate(circuitDefinition, symbol="", name="", blurb="") {
    return Gate.withoutKnownMatrix(symbol, name, blurb).
        withKnownCircuit(circuitDefinition).
        withStableDuration(circuitDefinition.stableDuration()).
        withCustomTextureTransform(args => advanceStateWithCircuit(
            args,
            circuitDefinition.withDisabledReasonsForEmbeddedContext(args.row, args.customContextFromGates),
            false).output).
        withHeight(circuitDefinition.numWires).
        withCustomDisableReasonFinder(args => {
            let def = circuitDefinition.withDisabledReasonsForEmbeddedContext(args.outerRow, args.context);
            for (let row = 0; row < def.numWires; row++) {
                for (let col = 0; col < def.columns.length; col++) {
                    let r = def.gateAtLocIsDisabledReason(new Point(col, row));
                    if (r !== undefined) {
                        return r;
                    }
                    if (def.gateInSlot(col, row) === Gates.Special.Measurement) {
                        return "hidden\nmeasure\nbroken";
                    }
                }
            }
            return undefined;
        });
}

/**
 * @param {!CircuitEvalArgs} args
 * @param {!CircuitDefinition} circuitDefinition
 * @param {!boolean} collectStats
 * @returns {!{output:!WglTexture,colQubitDensities:!Array.<!WglTexture>,customStats:!Array,customStatsMap:!Array}}
 */
function advanceStateWithCircuit(args, circuitDefinition, collectStats) {
    const numCols = circuitDefinition.columns.length;

    let colQubitDensities = [];
    let customStats = [];
    let customStatsMap = [];
    let output = KetTextureUtil.aggregateReusingIntermediates(
        args.stateTexture,
        Seq.range(numCols),
        (inputState, col) => {
            let controls = args.controls.and(circuitDefinition.colControls(col).shift(args.row));
            let controlTex = KetTextureUtil.control(args.wireCount, controls);

            let nextState = _advanceStateWithCircuitDefinitionColumn(
                args,
                new CircuitEvalArgs(
                    args.time,
                    args.row,
                    args.wireCount,
                    controls,
                    controlTex,
                    inputState,
                    args.customContextFromGates),
                circuitDefinition,
                col);

            if (collectStats) {
                let {qubitDensities, customGateStats} = _extractStateStatsNeededByCircuitColumn(
                    nextState, // We want to show stats after post-selection, so we use 'next' instead of 'input'.
                    circuitDefinition,
                    col,
                    controls,
                    controlTex,
                    args.time);
                colQubitDensities.push(qubitDensities);
                for (let {row, stat} of customGateStats) {
                    //noinspection JSUnusedAssignment
                    customStatsMap.push({
                        col,
                        row,
                        out: customStats.length
                    });
                    //noinspection JSUnusedAssignment
                    customStats.push(stat);
                }
            }

            KetTextureUtil.doneWithTexture(controlTex, "controlTex in advanceStateWithCircuit");
            return nextState;
        });

    if (collectStats) {
        const allWiresMask = (1 << circuitDefinition.numWires) - 1;
        colQubitDensities.push(KetTextureUtil.superpositionToQubitDensities(output, Controls.NONE, allWiresMask));
    }

    return {output, colQubitDensities, customStats, customStatsMap};
}

/**
 * @param {!WglTexture} state
 * @param {!CircuitDefinition} circuitDefinition
 * @param {!int} col
 * @param {!Controls} controls
 * @param {!WglTexture} controlTex
 * @param {!number} time
 * @private
 * @returns {!{qubitDensities:!WglTexture, customGateStats:!Array.<!{row:!int,stat:!WglTexture}>}}
 */
function _extractStateStatsNeededByCircuitColumn(
        state,
        circuitDefinition,
        col,
        controls,
        controlTex,
        time) {
    // Compute custom stats used by display gates.
    let customGateStats = [];
    for (let row of circuitDefinition.customStatRowsInCol(col)) {
        let statArgs = new CircuitEvalArgs(
            time,
            row,
            circuitDefinition.numWires,
            controls,
            controlTex,
            state,
            circuitDefinition.colCustomContextFromGates(col, row));
        let pipeline = circuitDefinition.columns[col].gates[row].customStatPipelineMaker(statArgs);
        let stat = KetTextureUtil.evaluatePipelineWithIntermediateCleanup(state, pipeline);
        customGateStats.push({row, stat});
    }

    // Compute individual qubit densities, where needed.
    let qubitDensities = KetTextureUtil.superpositionToQubitDensities(
        state,
        controls,
        circuitDefinition.colHasSingleQubitDisplayMask(col));

    return {qubitDensities, customGateStats};
}

/**
 * @param {!CircuitEvalArgs} outerContextArgs
 * @param {!CircuitEvalArgs} args
 * @param {!CircuitDefinition} circuitDefinition
 * @param {!int} col
 * @returns {!WglTexture}
 * @private
 */
function _advanceStateWithCircuitDefinitionColumn(
        outerContextArgs,
        args,
        circuitDefinition,
        col) {

    let colContext = Util.mergeMaps(
        args.customContextFromGates,
        circuitDefinition.colCustomContextFromGates(col, args.row));

    let setupArgsTemplate = new CircuitEvalArgs(
        outerContextArgs.time,
        undefined, // row is set by getSetupShadersInCol
        outerContextArgs.wireCount,
        outerContextArgs.controls,
        outerContextArgs.controlsTexture,
        undefined, // input texture is set below
        colContext);
    let colArgsTemplate = new CircuitEvalArgs(
        args.time,
        undefined, // row is set by operationShadersInColAt
        args.wireCount,
        args.controls,
        args.controlsTexture,
        undefined, // input texture is set below
        colContext);

    // Apply 'before column' setup shaders.
    let preparedState = KetTextureUtil.aggregateReusingIntermediates(
        args.stateTexture,
        circuitDefinition.getSetupShadersInCol(col, true, outerContextArgs.row),
        (v, f) => KetTextureUtil.applyCustomShader(f, setupArgsTemplate.withStateTexture(v)));

    // Apply gates in column.
    let almostNextState = KetTextureUtil.aggregateWithReuse(
        preparedState,
        circuitDefinition.operationShadersInColAt(col, outerContextArgs.row),
        (v, f) => KetTextureUtil.applyCustomShader(f, colArgsTemplate.withStateTexture(v)));
    let almostAlmostNextState = KetTextureUtil.aggregateWithReuse(
        almostNextState,
        circuitDefinition.textureTransformsInColAt(col, outerContextArgs.row),
        (v, f) => f(colArgsTemplate.withStateTexture(v)));

    // Apply 'after column' un-setup shaders.
    let nextState = KetTextureUtil.aggregateWithReuse(
        almostAlmostNextState,
        circuitDefinition.getSetupShadersInCol(col, false, outerContextArgs.row),
        (v, f) => KetTextureUtil.applyCustomShader(f, setupArgsTemplate.withStateTexture(v)));

    return nextState;
}

export {circuitDefinitionToGate, advanceStateWithCircuit}