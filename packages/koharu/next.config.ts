import { execSync } from 'node:child_process'
import type { NextConfig } from 'next'

// The commit this frontend was built from; the farm agent reports it with every chapter.
function gitCommit(): string {
  try {
    return execSync('git rev-parse --short=8 HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

const nextConfig: NextConfig = {
  devIndicators: false,
  transpilePackages: ['@koharu/bridge', '@koharu/ui'],
  output: 'export',
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_KOHARU_BUILD: gitCommit(),
  },
}

export default nextConfig
