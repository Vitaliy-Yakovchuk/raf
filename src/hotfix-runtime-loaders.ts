export const runtimeLoaderProofs: Readonly<Record<string, { sha256: string; proof: string; targets: readonly string[] }>> = {
  "bin/service.ts": {
    "targets": ["src/service-entry.ts"],
    "sha256": "b4d545e97f826ba9103602d41be73e42ab6a5404042a0d375bce787e485ba9f9",
    "proof": "The generation reader is retained before importing the fixed src/service-entry.ts in its own canonical root."
  },
  "src/cli.ts": {
    "targets": ["src/state-migration-guard.ts", "src/hotfix-activation.ts", "src/production-entry.ts"],
    "sha256": "922acdf417e36773bacb6e31c9bd8d4552e127a0d5a7d864327c3e9476e9a064",
    "proof": "The bootstrap identity is checked before pinning a registered reader; dynamic targets are fixed src module names under that bootstrap or its verified reader generation."
  },
  "src/service-entry.ts": {
    "targets": ["src/production-service-ports.ts"],
    "sha256": "9d1f8f2e51353e435ce5242ea71bbd056b627d766ab2e41431fc8d00b55b2db3",
    "proof": "verifyStateModule validates the selected host module against the pinned generation inventory before importing it; QA injection remains isolated."
  },
  "src/test-run-etchly-inventory.ts": {
    "targets": [],
    "sha256": "b8669079c952ae1028b84a17eb65249fa775666b1012aaeb172a409aec0abc48",
    "proof": "Only the test payload classifier in the selected project is imported after every audited source hash and canonical helper path have been checked; it does not resolve into excluded generation trees."
  }
};

export const runtimeLibraryProofs: Readonly<Record<string, { sha256: string; consumers: Readonly<Record<string, string>>; proof: string }>> = {
  "node_modules/typescript/lib/typescript.js": {
    "sha256": "569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39",
    "consumers": {
      "src/comment-policy.ts": "91781201685ddff654078c215e8ba9d1d862edc1c47480e3538a31df1d91ad2d",
      "src/hotfix-runtime-inventory.ts": "8fe738bd15d78f735620eec1a6bded93f81d04bdbcd221abffdbaceb875e32af"
    },
    "proof": "These exact consumers call only the synchronous parser, scanner and AST predicates/traversal APIs. They do not call TypeScript sys.require, compiler plugins, source-map installation or other module-loading APIs. The complete dependency tree and package metadata are protected."
  }
};
