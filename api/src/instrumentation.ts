export async function register(): Promise<void> {
    if (
        process.env.NEXT_RUNTIME === 'nodejs' &&
        process.env.TRUEBUILD_ENABLE_MODELS === '1' &&
        process.env.TRUEBUILD_OWNER_ACTION === 'resume'
    ) {
        const { initializeModelRuntimeFromEnvironment } = await import('./server/model-runtime')
        await initializeModelRuntimeFromEnvironment()
    }
}
