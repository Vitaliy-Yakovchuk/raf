export const runtimeLoaderProofs: Readonly<Record<string, { sha256: string; proof: string; targets: readonly string[] }>> = {
  "bin/service.ts": {
    "targets": ["src/service-entry.ts"],
    "sha256": "b4d545e97f826ba9103602d41be73e42ab6a5404042a0d375bce787e485ba9f9",
    "proof": "The generation reader is retained before importing the fixed src/service-entry.ts in its own canonical root."
  },
  "src/cli.ts": {
    "targets": ["src/state-migration-guard.ts", "src/hotfix-activation.ts", "src/production-entry.ts"],
    "sha256": "298ec9023cbad5d4cf5613aebe9847b0f06a737b5c2d7e904082de6d5047223b",
    "proof": "The bootstrap identity is checked before pinning a registered reader; dynamic targets are fixed src module names under that bootstrap or its verified reader generation."
  },
  "src/service-entry.ts": {
    "targets": ["src/production-service-ports.ts"],
    "sha256": "806b850828e089dc2f56195da0c98c6df01235b583a8330fa44e9b0effcbbe0b",
    "proof": "verifyStateModule validates the selected host module against the pinned generation inventory before importing it; QA injection remains isolated."
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
      "src/hotfix-runtime-inventory.ts": "8fe738bd15d78f735620eec1a6bded93f81d04bdbcd221abffdbaceb875e32af"
    },
    "proof": "These exact consumers call only the synchronous parser, scanner and AST predicates/traversal APIs. They do not call TypeScript sys.require, compiler plugins, source-map installation or other module-loading APIs. The complete dependency tree and package metadata are protected."
  }
};
