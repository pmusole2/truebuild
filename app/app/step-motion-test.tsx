import { Suspense, lazy, useState, type ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { AppButton } from '../src/ui/button'
import { Screen, Stack } from '../src/ui/surface'
import { Body, Caption, Title } from '../src/ui/text'
import { FeedbackProvider } from '../src/ui/feedback'

const FixtureHint =
    __DEV__ && process.env.EXPO_PUBLIC_PROVIDER_MODE === 'fixture'
        ? lazy(async () => {
              const { StepMotionHint } = await import('../src/features/step-motion/step-motion-hint')
              const { RECORDED_STEP_MOTION_SCENES } =
                  await import('../src/features/step-motion/__fixtures__/recorded-scenes')

              function RecordedHint({ kind, replay }: { kind: string; replay: number }): ReactElement {
                  const scene =
                      kind === 'press'
                          ? RECORDED_STEP_MOTION_SCENES.press
                          : kind === 'slide'
                            ? RECORDED_STEP_MOTION_SCENES.slide
                            : kind === 'inspect'
                              ? RECORDED_STEP_MOTION_SCENES.inspect
                              : RECORDED_STEP_MOTION_SCENES.hinge
                  return <StepMotionHint key={`${kind}:${replay}`} scene={scene} active />
              }

              return { default: RecordedHint }
          })
        : null

/** Offline fixture route. It has no product navigation entry and cannot render outside development fixture mode. */
export default function StepMotionTestRoute(): ReactElement | null {
    const params = useLocalSearchParams<{ kind?: string; reduced?: string }>()
    const [replay, setReplay] = useState(0)
    if (FixtureHint === null) return null
    const kind = params.kind ?? 'hinge'
    return (
        <FeedbackProvider reduceMotion={params.reduced === '1'}>
            <Screen header="hidden" testID="step-motion-fixture">
                <Stack gap="md">
                    <Caption>Recorded scene · offline fixture</Caption>
                    <Title>How it moves</Title>
                    <Body>{kind === 'inspect' ? 'Check the contents against the printed list.' : 'Directions'}</Body>
                    <View style={styles.hint}>
                        <Suspense fallback={null}>
                            <FixtureHint kind={kind} replay={replay} />
                        </Suspense>
                    </View>
                    <Caption>
                        {params.reduced === '1' ? 'Reduced motion · finished pose' : 'Three loops, then Replay'}
                    </Caption>
                    <AppButton label="Restart fixture" onPress={(): void => setReplay((value) => value + 1)} />
                </Stack>
            </Screen>
        </FeedbackProvider>
    )
}

const styles = StyleSheet.create({ hint: { width: 320, alignSelf: 'center' } })
