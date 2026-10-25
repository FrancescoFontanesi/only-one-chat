// Codex overrides for the throwaway profiles of tests and the transcript
// recorder, never for production launches (the user's profile is theirs):
// - features.plugins=false: no startup sync from github.com/openai/plugins
//   through the user's git, which can also outlive the server;
// - skills.bundled.enabled=false: no system skills unpacked into the profile.
// Together they keep recordings reproducible and free of network side effects.
// Sources at rust-v0.164.0: core-plugins/src/manager.rs:763,
// config/src/skills_config.rs:138-156.

export const ISOLATED_PROFILE_OVERRIDES: readonly string[] = [
  'features.plugins=false',
  'skills.bundled.enabled=false',
];
