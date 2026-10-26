export const runtimeLoaderProofs: Readonly<Record<string, { sha256: string; proof: string; targets: readonly string[] }>> = {
  "bin/service.ts": {
    "targets": ["src/service-entry.ts"],
    "sha256": "b4d545e97f826ba9103602d41be73e42ab6a5404042a0d375bce787e485ba9f9",
    "proof": "The generation reader is retained before importing the fixed src/service-entry.ts in its own canonical root."
  },
  "src/cli.ts": {
    "targets": ["src/state-migration-guard.ts", "src/hotfix-activation.ts", "src/production-entry.ts"],
    "sha256": "d3090229bed07c8de7fc7382f9b44bed4208a34b120d63ff9184cba567054f72",
    "proof": "The bootstrap identity is checked before pinning a registered reader; dynamic targets are fixed src module names under that bootstrap or its verified reader generation."
  },
  "src/service-entry.ts": {
    "targets": ["src/production-service-ports.ts"],
    "sha256": "b89c59de0be9ac9bde525225280f2f9f4a1b64fed35c6bf261491558724368f6",
    "proof": "The host module path is set by the service runtime of the retained generation before importing it; QA injection remains isolated."
  },
  "src/test-run-etchly-inventory.ts": {
    "targets": [],
    "sha256": "e8af2d0bb1a79e7dc81919c55071728f74457c88d7fceddab081a30caa3f3ad6",
    "proof": "Only the test payload classifier in the selected project is imported after every audited source hash and canonical helper path have been checked; it does not resolve into excluded generation trees."
  }
};

export const runtimeLibraryProofs: Readonly<Record<string, { sha256: string; consumers: Readonly<Record<string, string>>; proof: string }>> = {
  "node_modules/typescript/lib/typescript.js": {
    "sha256": "569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39",
    "consumers": {
      "src/test-run-etchly-integration.ts": "18d33eff8e9fbf53048a18921031a3c0421ee50d0f350ba9487c4369e78ec70e",
      "src/comment-policy.ts": "91781201685ddff654078c215e8ba9d1d862edc1c47480e3538a31df1d91ad2d",
      "src/hotfix-runtime-inventory.ts": "f8cc6a86d0a52e2e31e465400116c59e273a2c8276b4c8829630d610f127a0cb"
    },
    "proof": "These exact consumers call only the synchronous parser, scanner and AST predicates/traversal APIs. They do not call TypeScript sys.require, compiler plugins, source-map installation or other module-loading APIs. The complete dependency tree and package metadata are protected."
  }
};
