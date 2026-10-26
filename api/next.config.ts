import type { NextConfig } from 'next'

const config: NextConfig = {
    transpilePackages: ['@truebuild/contracts'],
    poweredByHeader: false,
}

export default config
