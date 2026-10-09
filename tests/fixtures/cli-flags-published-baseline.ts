/**
 * THE PUBLISHED FLAG SURFACE, FROZEN.
 *
 * WHY A FIXTURE AND NOT A GIT READ. `tests/changelog-claims.test.ts` ships to
 * the public mirror, whose export tree is an ORPHAN SNAPSHOT with no history -
 * a gate that derived this from `git show 24da8bf3:…` would be silently vacuous
 * there. Same reasoning as `catastrophic-screen-0.6.0.ts`.
 *
 * IT IS SELF-INVALIDATING - AND THE ANCHOR IS NOT `package.json`. It used
 * to be: `BASELINE_VERSION` was asserted against the live manifest version, so
 * "the first release bump turns the gate RED and forces a deliberate
 * regeneration". That was true, and it was ALSO unsatisfiable. The proposition
 * it encoded is *"the manifest version equals the LAST PUBLISHED version"*,
 * which holds only BETWEEN releases and is false for the whole of a release
 * preparation - from the moment the bump lands until the publish completes.
 * No ordering satisfies it, so `npm publish`'s own `prepublishOnly` suite
 * aborted the publish it was guarding, and `build-mirror.sh` could never pass.
 * Measured during release testing.
 *
 * THE ANCHOR IS NOW `LAST_PUBLISHED_VERSION` BELOW: a second committed
 * constant that moves ONLY when a publish happens, never when a version is
 * bumped. Regenerating this file before the publish would re-anchor a frozen
 * instrument to an artifact nobody has released, and would turn the "no public
 * flag removed since the last release" check into a comparison of HEAD with
 * itself - which is the shape the whole gate exists to prevent.
 *
 * Regenerate AT THE PUBLISH, not at the bump: derive
 * `(?:new Option|\.option)\(…\)` over `packages/cli/src`, sorted, and move
 * BOTH `BASELINE_VERSION` and `LAST_PUBLISHED_VERSION` to the version that was
 * actually published.
 */

/** The version this baseline was taken at. */
export const BASELINE_VERSION = "0.9.2";

/**
 * THE VERSION THAT IS ACTUALLY ON THE REGISTRY, AS A COMMITTED CONSTANT.
 *
 * WHY A CONSTANT AND NOT A LOOKUP - this is the constraint that decides the
 * design, and it is the same one that made `BASELINE_FLAGS` a fixture rather
 * than a `git show`. `tests/changelog-claims.test.ts` ships to the public
 * mirror, whose export tree is an ORPHAN SNAPSHOT WITH NO GIT HISTORY (proved:
 * `build-mirror.sh` copies `git ls-files -- packages/cli` minus
 * `publish/manifest.txt` and runs no `git init` without `--push`, so no `.git`
 * exists there). A gate reading `git tag`/`git show` is therefore SILENTLY
 * VACUOUS in the mirror; a gate reading `npm view` is vacuous offline and in
 * the mirror both. Only a committed constant survives the orphan snapshot.
 *
 * IT IS A DIFFERENT FACT FROM `package.json`'s version, and that is the
 * whole point: during a release preparation the two legitimately differ, and
 * the gate must permit exactly that difference and nothing else.
 *
 * MOVE THIS LINE ONLY AS PART OF A PUBLISH. Never with a bump.
 */
export const LAST_PUBLISHED_VERSION = "0.9.2";

/** Every flag registered anywhere in packages/cli/src at that publish point. */
export const BASELINE_FLAGS: readonly string[] = [
  '--all',
  '--api-key',
  '--api-key-env',
  '--api-url',
  '--attach',
  '--base',
  '--base-url',
  '--category',
  '--check',
  '--cmd-timeout',
  '--commands',
  '--conversation',
  '--count',
  '--detached',
  '--draft',
  '--dry-run',
  '--effort',
  '--env',
  '--filter',
  '--for',
  '--force',
  '--format',
  '--header',
  '--json',
  '--limit',
  '--lines',
  '--list',
  '--max-time',
  '--max-tokens',
  '--max-tool-calls-per-turn',
  '--max-turns',
  '--mime',
  '--model',
  '--name',
  '--new',
  '--no-color',
  '--no-follow',
  '--no-observe',
  '--no-open',
  '--no-plan',
  '--no-stream',
  '--no-web',
  '--oauth',
  '--observe',
  '--output',
  '--output-types',
  '--page',
  '--pinned',
  '--plan',
  '--project',
  '--prompt',
  '--provider',
  '--purpose',
  '--push',
  '--raw',
  '--resume',
  '--reveal',
  '--revoke',
  '--rolling',
  '--schedule',
  '--session',
  '--skip-test',
  '--stdin',
  '--style',
  '--task',
  '--timeout',
  '--tool-protocol',
  '--type',
  '--url',
  '--verify',
  '--verify-attempts',
  '--week',
  '--yes',
];
