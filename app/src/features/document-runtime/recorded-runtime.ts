import {
    assembleDocumentV2,
    cameraAccessV2,
    documentMaterialV2,
    recordedDocumentFactsV2,
    recordedProvenanceV2Schema,
    syntheticAuthorV2Schema,
    syntheticDocumentFactsV2,
    screenDocumentV2Schema,
    screenProposalV2Schema,
    verifyDocumentAgainstInputsV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
} from '@truebuild/contracts'
import home from '../documents/recorded/recorded-home.proposal.json'
import homeProvenance from '../documents/recorded/recorded-home.runtime.json'
import single from '../documents/recorded/recorded-home-library-single.proposal.json'
import singleProvenance from '../documents/recorded/recorded-home-library-single.runtime.json'
import multiple from '../documents/recorded/recorded-home-library-multiple.proposal.json'
import multipleProvenance from '../documents/recorded/recorded-home-library-multiple.runtime.json'
import add from '../documents/recorded/recorded-add-empty.proposal.json'
import addProvenance from '../documents/recorded/recorded-add-empty.runtime.json'
import pages from '../documents/recorded/recorded-pages.proposal.json'
import pagesProvenance from '../documents/recorded/recorded-pages.runtime.json'
import stopped from '../documents/recorded/recorded-pages-cancelled.proposal.json'
import stoppedProvenance from '../documents/recorded/recorded-pages-cancelled.runtime.json'
import reading from '../documents/recorded/recorded-reading.proposal.json'
import readingProvenance from '../documents/recorded/recorded-reading.runtime.json'
import activeReading from '../documents/recorded/recorded-reading-active.proposal.json'
import activeReadingProvenance from '../documents/recorded/recorded-reading-active.runtime.json'
import homeSaving from '../documents/recorded/recorded-home-saving.proposal.json'
import homeSavingProvenance from '../documents/recorded/recorded-home-saving.runtime.json'
import singleSaving from '../documents/recorded/recorded-home-library-single-saving.proposal.json'
import singleSavingProvenance from '../documents/recorded/recorded-home-library-single-saving.runtime.json'
import multipleSaving from '../documents/recorded/recorded-home-library-multiple-saving.proposal.json'
import multipleSavingProvenance from '../documents/recorded/recorded-home-library-multiple-saving.runtime.json'
import addSaving from '../documents/recorded/recorded-add-empty-saving.proposal.json'
import addSavingProvenance from '../documents/recorded/recorded-add-empty-saving.runtime.json'
import pagesSaving from '../documents/recorded/recorded-pages-saving.proposal.json'
import pagesSavingProvenance from '../documents/recorded/recorded-pages-saving.runtime.json'
import stoppedSaving from '../documents/recorded/recorded-pages-cancelled-saving.proposal.json'
import stoppedSavingProvenance from '../documents/recorded/recorded-pages-cancelled-saving.runtime.json'
import readingSaving from '../documents/recorded/recorded-reading-saving.proposal.json'
import readingSavingProvenance from '../documents/recorded/recorded-reading-saving.runtime.json'
import globalMore from '../documents/recorded/recorded-more-global.proposal.json'
import globalMoreProvenance from '../documents/recorded/recorded-more-global.runtime.json'
import globalJudge from '../documents/recorded/recorded-judge-global.proposal.json'
import globalJudgeProvenance from '../documents/recorded/recorded-judge-global.runtime.json'
import pageCamera from '../documents/recorded/recorded-camera-page.proposal.json'
import pageCameraProvenance from '../documents/recorded/recorded-camera-page.runtime.json'
import pageCameraSaving from '../documents/recorded/recorded-camera-page-saving.proposal.json'
import pageCameraSavingProvenance from '../documents/recorded/recorded-camera-page-saving.runtime.json'
import pageCameraAllow from '../documents/recorded/recorded-camera-page-allow.proposal.json'
import pageCameraAllowProvenance from '../documents/recorded/recorded-camera-page-allow.runtime.json'
import pageCameraAllowSaving from '../documents/recorded/recorded-camera-page-allow-saving.proposal.json'
import pageCameraAllowSavingProvenance from '../documents/recorded/recorded-camera-page-allow-saving.runtime.json'
import pageCameraSettings from '../documents/recorded/recorded-camera-page-settings.proposal.json'
import pageCameraSettingsProvenance from '../documents/recorded/recorded-camera-page-settings.runtime.json'
import pageCameraSettingsSaving from '../documents/recorded/recorded-camera-page-settings-saving.proposal.json'
import pageCameraSettingsSavingProvenance from '../documents/recorded/recorded-camera-page-settings-saving.runtime.json'
import pageCameraRetry from '../documents/recorded/recorded-camera-page-retry.proposal.json'
import pageCameraRetryProvenance from '../documents/recorded/recorded-camera-page-retry.runtime.json'
import pageCameraRetrySaving from '../documents/recorded/recorded-camera-page-retry-saving.proposal.json'
import pageCameraRetrySavingProvenance from '../documents/recorded/recorded-camera-page-retry-saving.runtime.json'
import { sha256Hex } from '../documents/sha256'
import { resultLayoutDocument } from './result-layout-runtime'
import { questionLayoutDocument } from './question-layout-runtime'

interface Recording {
    readonly proposal: unknown
    readonly provenance: Readonly<Record<string, unknown>>
}

const initialHome: Recording = {
    proposal: home,
    provenance: homeProvenance,
}

/** Select only the recorded nonfactual route family. The validator still decides whether the exact record fits. */
function recordingFor(inputs: ScreenContextInputsV2): Recording | null {
    // Launch records bind live lists/page identities, not unrelated step, photo, result or failure contexts.
    if (
        inputs.stepId !== null ||
        inputs.captureId !== null ||
        inputs.result !== null ||
        inputs.failure !== null ||
        inputs.companionAnswer != null ||
        inputs.uiState?.capture != null ||
        (inputs.kind === 'home' && inputs.session !== null)
    )
        return null
    const saving = inputs.uiState?.busy?.activity === 'saving'
    switch (inputs.kind) {
        case 'home': {
            const count = inputs.uiState?.library?.entries.length ?? 0
            return count === 0
                ? saving
                    ? { proposal: homeSaving, provenance: homeSavingProvenance }
                    : initialHome
                : count === 1
                  ? saving
                      ? { proposal: singleSaving, provenance: singleSavingProvenance }
                      : { proposal: single, provenance: singleProvenance }
                  : saving
                    ? { proposal: multipleSaving, provenance: multipleSavingProvenance }
                    : { proposal: multiple, provenance: multipleProvenance }
        }
        case 'add':
            return saving
                ? { proposal: addSaving, provenance: addSavingProvenance }
                : { proposal: add, provenance: addProvenance }
        case 'pages':
            return inputs.uiState?.cancelled?.reading === true
                ? saving
                    ? { proposal: stoppedSaving, provenance: stoppedSavingProvenance }
                    : { proposal: stopped, provenance: stoppedProvenance }
                : saving
                  ? { proposal: pagesSaving, provenance: pagesSavingProvenance }
                  : { proposal: pages, provenance: pagesProvenance }
        case 'reading':
            return inputs.uiState?.busy?.activity === 'reading'
                ? { proposal: activeReading, provenance: activeReadingProvenance }
                : saving
                  ? { proposal: readingSaving, provenance: readingSavingProvenance }
                  : { proposal: reading, provenance: readingProvenance }
        case 'more':
            if (
                inputs.session !== null ||
                inputs.uiState?.settings?.storage !== true ||
                (inputs.uiState.language?.options.length ?? 0) === 0 ||
                !['how-it-works', 'settings', 'tips', 'about-this-check'].every((section) =>
                    inputs.uiState?.sections?.some((available) => available === section),
                )
            )
                return null
            return { proposal: globalMore, provenance: globalMoreProvenance }
        case 'judge':
            return inputs.session === null ? { proposal: globalJudge, provenance: globalJudgeProvenance } : null
        case 'camera': {
            const camera = inputs.uiState?.camera
            if (camera?.mode !== 'manual-page') return null
            const access = cameraAccessV2(camera)
            if (access === 'allow')
                return saving
                    ? { proposal: pageCameraAllowSaving, provenance: pageCameraAllowSavingProvenance }
                    : { proposal: pageCameraAllow, provenance: pageCameraAllowProvenance }
            if (access === 'settings')
                return saving
                    ? { proposal: pageCameraSettingsSaving, provenance: pageCameraSettingsSavingProvenance }
                    : { proposal: pageCameraSettings, provenance: pageCameraSettingsProvenance }
            if (access === 'retry')
                return saving
                    ? { proposal: pageCameraRetrySaving, provenance: pageCameraRetrySavingProvenance }
                    : { proposal: pageCameraRetry, provenance: pageCameraRetryProvenance }
            return saving
                ? { proposal: pageCameraSaving, provenance: pageCameraSavingProvenance }
                : { proposal: pageCamera, provenance: pageCameraProvenance }
        }
        default:
            return null
    }
}

/**
 * Bind unchanged model-authored trees to current data. Identity/tables are assembled here; the model's actual layout,
 * copy and actions are never patched. A record that fails any current safety, action, wording or identity rule is absent.
 * Author model/effort/date come from the retained record; provider latency/tokens remain unknown.
 */
export function recordedDocument(inputs: ScreenContextInputsV2): ScreenDocumentV2 | null {
    const layout = questionLayoutDocument(inputs) ?? resultLayoutDocument(inputs)
    if (layout !== null) return layout
    const record = recordingFor(inputs)
    if (record === null) return null
    const proposal = screenProposalV2Schema.safeParse(record.proposal)
    const source = record.provenance
    if (source.evidence === 'synthetic-fixture') {
        const author = syntheticAuthorV2Schema.safeParse(source.authoring)
        if (!proposal.success || !author.success || source.model !== null || source.effort !== null) return null
        const candidate = assembleDocumentV2(
            documentMaterialV2(inputs),
            proposal.data,
            syntheticDocumentFactsV2(author.data),
            { sha256Hex, now: (): Date => new Date() },
        )
        const parsed = screenDocumentV2Schema.safeParse(candidate)
        return parsed.success && verifyDocumentAgainstInputsV2(parsed.data, inputs, sha256Hex).length === 0
            ? parsed.data
            : null
    }
    if (source.evidence !== 'recorded-generation' || source.authoring !== undefined) return null
    const provenance = recordedProvenanceV2Schema.safeParse({
        fixtureId: source.fixtureId,
        model: source.model,
        effort: source.effort,
        recordedAt: source.recordedAt,
        promptVersion: source.promptVersion,
        repaired: source.repaired,
    })
    if (!proposal.success || !provenance.success) return null
    const candidate = assembleDocumentV2(
        documentMaterialV2(inputs),
        proposal.data,
        recordedDocumentFactsV2(provenance.data),
        { sha256Hex, now: (): Date => new Date() },
    )
    const parsed = screenDocumentV2Schema.safeParse(candidate)
    return parsed.success && verifyDocumentAgainstInputsV2(parsed.data, inputs, sha256Hex).length === 0
        ? parsed.data
        : null
}
