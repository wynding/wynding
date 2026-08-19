#!/usr/bin/env node
// check-native-invariants.mjs — the gate over the two committed native projects (#135).
//
// WHY THIS EXISTS. `apps/mobile/ios` and `apps/mobile/android` are GENERATED trees that are
// nonetheless committed (design note: native config has to live somewhere). That combination
// has a specific failure mode: a template regeneration, an Xcode UI click, or a stray commit
// silently reverts a hand-made decision, and nothing notices until a device does — or, for
// the signing rule below, until it is already public. Everything asserted here is a decision
// someone made on purpose, in a file a tool also writes.
//
// IF THIS FAILS ON `DEVELOPMENT_TEAM`, DO NOT "FIX" IT BY COMMITTING THE VALUE. This
// repository is public and an Apple development team ID is a durable, personally-linked
// identifier. Xcode writes `DEVELOPMENT_TEAM` into the tracked `project.pbxproj` the moment a
// team is selected in its UI, which is exactly the accident this catches. The supported
// workflow is `apps/mobile/ios/LocalSigning.xcconfig` — untracked, gitignored, pulled in by an
// OPTIONAL include from both committed xcconfigs. See apps/mobile/README.md.
//
// SDK-FREE, ON PURPOSE. This runs inside `pnpm run verify`, which runs on Ubuntu in CI where
// there is no Xcode and no Android SDK. So it is pure text over files — no `plutil`, no
// `xcodebuild`, no Gradle. That bounds it, and the bound is worth stating: it proves the
// SETTINGS are present and say what they should, not that the projects compile. Compilation
// is the device pass, which is a human step and deliberately not gated here.
//
// DELIBERATELY NOT CHECKED: asset catalogs and resource references. `@capacitor/assets`
// generates that matrix and owns its own output contract; re-asserting it here would be
// brittle against tooling updates and would buy little — a wrong icon fails VISIBLY, on the
// home screen, which is the one class of defect that does not need a machine to notice.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOBILE = join(ROOT, 'apps', 'mobile');
const IOS = join(MOBILE, 'ios');
const ANDROID = join(MOBILE, 'android');

/** @type {string[]} */ const failures = [];
/** @type {string[]} */ const passed = [];

const ok = (label) => passed.push(label);
const bad = (label, detail) => failures.push(`${label}\n   ${detail}`);
const expect = (condition, label, detail) => (condition ? ok(label) : bad(label, detail));

const rel = (p) => relative(ROOT, p);

/** Read a file the checks require. Returns null (and records a failure) when it is missing,
 *  so a deleted project reports as a missing file rather than as a passing check. */
function required(path, label) {
  if (!existsSync(path)) {
    bad(label, `missing file: ${rel(path)}`);
    return null;
  }
  return readFileSync(path, 'utf8');
}

// --- Minimal plist readers. A real parser is not worth a dependency for four keys, and the
// file is machine-written so its shape is stable; each reader returns null when the key is
// absent, which every call site treats as a failure rather than as a default. ---
const plistTrue = (src, key) => new RegExp(`<key>${key}</key>\\s*<true\\s*/>`).test(src);
const plistString = (src, key) => {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(src);
  return m === null ? null : m[1].trim();
};
const plistArray = (src, key) => {
  const m = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(src);
  return m === null
    ? null
    : [...m[1].matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1].trim());
};

/** Split project.pbxproj into its build configurations, each with its name and the display
 *  name of its base configuration file (the `baseConfigurationReference` comment). */
function buildConfigurations(pbx) {
  return pbx
    .split('isa = XCBuildConfiguration;')
    .slice(1)
    .map((part) => {
      const end = part.indexOf('\n\t\t};');
      const block = end === -1 ? part : part.slice(0, end);
      const name = /^\t{3}name = (\w+);/m.exec(block);
      const base = /baseConfigurationReference = \w+ \/\* ([^*]+?) \*\//.exec(block);
      return { name: name?.[1] ?? null, base: base?.[1]?.trim() ?? null, block };
    });
}

// =====================================================================================
// 1. Identity — the native projects agree with capacitor.config.ts.
//    `cap add` BAKES these in; editing the config afterwards does not re-stamp either
//    project, so a mismatch means the trees and the config have silently diverged.
// =====================================================================================
const capConfig = required(join(MOBILE, 'capacitor.config.ts'), 'capacitor.config.ts present');
const appId = capConfig && /appId:\s*'([^']+)'/.exec(capConfig)?.[1];
const appName = capConfig && /appName:\s*'([^']+)'/.exec(capConfig)?.[1];
const webDir = capConfig && /webDir:\s*'([^']+)'/.exec(capConfig)?.[1];

// Assert the PARSE, not just the values. Every identity check below is guarded on appId or
// appName being truthy, so a config these regexes cannot read — double quotes, a reformat that
// moves the value onto its own line — would skip all four in silence and still print a pass
// with a smaller total that nothing compares against. These checks cannot pass vacuously.
expect(
  Boolean(appId),
  'capacitor.config.ts declares appId',
  `could not read \`appId: '…'\` from capacitor.config.ts; the bundle identifier, ` +
    `applicationId and namespace checks all read it`,
);
expect(
  Boolean(appName),
  'capacitor.config.ts declares appName',
  `could not read \`appName: '…'\` from capacitor.config.ts; the iOS display name and ` +
    `Android app_name checks both read it`,
);

expect(
  webDir === '../web/dist-host',
  'capacitor.config.ts packages the Host build',
  `webDir is ${String(webDir)}, expected '../web/dist-host' — packaging any other directory ` +
    `would ship a build that never declared itself hosted (ADR 0012, ADR 0013).`,
);

const pbx = required(join(IOS, 'App', 'App.xcodeproj', 'project.pbxproj'), 'iOS project present');
const gradle = required(join(ANDROID, 'app', 'build.gradle'), 'Android app/build.gradle present');
const strings = required(
  join(ANDROID, 'app', 'src', 'main', 'res', 'values', 'strings.xml'),
  'Android strings.xml present',
);
const infoPlist = required(join(IOS, 'App', 'App', 'Info.plist'), 'iOS Info.plist present');
const manifest = required(
  join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml'),
  'AndroidManifest.xml present',
);

if (pbx !== null && appId) {
  const ids = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1].trim());
  expect(
    ids.length > 0 && ids.every((id) => id === appId),
    'iOS bundle identifier matches appId',
    `PRODUCT_BUNDLE_IDENTIFIER values ${JSON.stringify(ids)} do not all equal ${appId}`,
  );
}
if (gradle !== null && appId) {
  expect(
    new RegExp(`applicationId\\s+"${appId}"`).test(gradle),
    'Android applicationId matches appId',
    `app/build.gradle has no applicationId "${appId}"`,
  );
  expect(
    new RegExp(`namespace\\s*=\\s*"${appId}"`).test(gradle),
    'Android namespace matches appId',
    `app/build.gradle has no namespace = "${appId}"`,
  );
}
if (infoPlist !== null && appName) {
  expect(
    plistString(infoPlist, 'CFBundleDisplayName') === appName,
    'iOS display name matches appName',
    `CFBundleDisplayName is ${String(plistString(infoPlist, 'CFBundleDisplayName'))}, expected ${appName}`,
  );
}
if (strings !== null && appName) {
  expect(
    new RegExp(`<string name="app_name">${appName}</string>`).test(strings),
    'Android app_name matches appName',
    `strings.xml has no <string name="app_name">${appName}</string>`,
  );
}

// =====================================================================================
// 2. Signing hygiene — no team in a tracked file, and the local override actually wired.
// =====================================================================================
const SKIP_DIRS = new Set([
  'public',
  'Pods',
  'build',
  'DerivedData',
  'xcuserdata',
  'output',
  '.build',
  '.swiftpm',
  'capacitor-cordova-ios-plugins',
]);
const SKIP_FILES = new Set(['capacitor.config.json', 'config.xml']);
// LocalSigning.xcconfig is the file that is SUPPOSED to carry a team, and it is gitignored;
// scanning it would fail the check on precisely the machine that set signing up correctly.
// The exemption is by PATH, not by name, because the gitignore rule it pairs with is anchored
// to this one location: a copy made anywhere else — next to the Xcode project, say, where a
// developer working there might reasonably put it — is a TRACKABLE file and must be scanned.
const LOCAL_SIGNING = join(IOS, 'LocalSigning.xcconfig');
const BINARY = /\.(png|jpe?g|gif|pdf|zip|jar|keystore|jks|ttf|otf|ico|webp|car)$/i;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // `lstat`, not `stat`: `stat` follows symlinks and THROWS on a dangling one, which would
    // abort `verify` with a raw ENOENT naming no invariant. Xcode and SPM leave scratch links
    // under here and an interrupted `cap sync` can leave a broken one. A symlink is also never
    // descended into — a loop would hang the walk, and nothing this checks lives behind one.
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, out);
    } else if (full !== LOCAL_SIGNING && !SKIP_FILES.has(entry) && !BINARY.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// A selected team reaches a tracked file under more than one spelling, and Xcode chooses
// between them by project vintage rather than by anything the developer sees: the build
// setting `DEVELOPMENT_TEAM` inside an XCBuildConfiguration, that same setting carrying a
// condition (`DEVELOPMENT_TEAM[sdk=iphoneos*]`), and `DevelopmentTeam` inside PBXProject's
// TargetAttributes — which is the form THIS project's vintage writes, beside the
// `ProvisioningStyle` it already has. All three are the same accident, so all three match.
// The optional quotes are load-bearing, not defensive: Xcode's pbxproj writer quotes any key
// outside `[A-Za-z0-9_$/:.-]`, so a per-SDK team is written `"DEVELOPMENT_TEAM[sdk=iphoneos*]"
// = ABC123;` — with the closing quote sitting between the bracket and the `=`. Without them
// the conditional branch matches only an unquoted spelling the writer never emits, i.e. never;
// a developer setting a device-only signing team would then pass this check and commit their
// team ID to a public repository, which is the exact accident this file exists to prevent.
const TEAM_SETTING = /"?((?:DEVELOPMENT_TEAM|DevelopmentTeam)(?:\[[^\]]*\])?)"?\s*=\s*([^;\n]*)/g;

const iosFiles = walk(IOS);
const leaks = [];
for (const file of iosFiles) {
  for (const m of readFileSync(file, 'utf8').matchAll(TEAM_SETTING)) {
    const value = m[2].trim().replace(/^"|"$/g, '').trim();
    if (value !== '') leaks.push(`${rel(file)}: ${m[1]} = ${value}`);
  }
}
expect(
  leaks.length === 0,
  `no development team in any of the ${String(iosFiles.length)} scanned iOS files`,
  `${leaks.join('\n   ')}\n   → Move it to apps/mobile/ios/LocalSigning.xcconfig (untracked). ` +
    `This repository is public; see this script's header.`,
);

for (const name of ['debug.xcconfig', 'release.xcconfig']) {
  const src = required(join(IOS, name), `${name} present`);
  if (src === null) continue;
  expect(
    /^#include\?\s+"LocalSigning\.xcconfig"$/m.test(src),
    `${name} optionally includes LocalSigning.xcconfig`,
    `${name} has no \`#include? "LocalSigning.xcconfig"\` line. A gitignored xcconfig that ` +
      `nothing includes is inert — the developer would edit it and nothing would read it.`,
  );
}

if (pbx !== null) {
  const configs = buildConfigurations(pbx);
  // The association is as load-bearing as the include: Capacitor's template wires
  // debug.xcconfig into the Debug configurations and leaves Release with NO base
  // configuration at all, so without release.xcconfig a Release build reads no local signing.
  for (const want of ['Debug', 'Release']) {
    const matching = configs.filter((c) => c.name === want);
    const expected = `${want.toLowerCase()}.xcconfig`;
    expect(
      matching.length > 0 && matching.every((c) => c.base === expected),
      `every ${want} configuration reads ${expected}`,
      `found ${String(matching.length)} ${want} configuration(s) with base configurations ` +
        `${JSON.stringify(matching.map((c) => c.base))}, expected all to be ${expected}`,
    );
  }
}

// The scan above skips LocalSigning.xcconfig BY NAME — it is the one file that is supposed to
// carry a team, and scanning it would fail this check on exactly the machine that set signing
// up correctly. That exclusion is a hole on its own: `git add -f` beats any ignore rule, and a
// committed LocalSigning.xcconfig would then sail past both the scan (skipped) and the ignore
// assertion below (the rule still exists) with a team ID in it, in a public repository. So the
// file's TRACKED state is asserted directly, the same way the web payload is.
let trackedSigning = null;
try {
  trackedSigning = execFileSync(
    'git',
    ['ls-files', '--', 'apps/mobile/ios/LocalSigning.xcconfig'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean);
} catch {
  trackedSigning = null;
}
expect(
  trackedSigning !== null && trackedSigning.length === 0,
  'LocalSigning.xcconfig is not committed',
  trackedSigning === null
    ? 'could not ask git — this check cannot pass vacuously'
    : `${trackedSigning.join(', ')} is TRACKED. It carries a development team ID and this ` +
        `repository is public: \`git rm --cached\` it, and rotate the identity if it was pushed.`,
);

const rootGitignore = required(join(ROOT, '.gitignore'), 'root .gitignore present');
expect(
  rootGitignore !== null && /^apps\/mobile\/ios\/LocalSigning\.xcconfig$/m.test(rootGitignore),
  'LocalSigning.xcconfig is gitignored',
  'the root .gitignore does not name apps/mobile/ios/LocalSigning.xcconfig, so a developer ' +
    'who creates it could commit their team ID to a public repository',
);

// The same rule for the material that signs a RELEASE, where the stakes are a tier higher: a
// team ID is an identifier, but a Play app-signing key or an exported private key is a live
// credential that cannot be rotated once public, only abandoned. Both .gitignore files below
// come from a template — Android's ships the keystore rules COMMENTED OUT — so uncommenting
// them is exactly the hand-made decision a regeneration reverts, silently, before the first
// release build. The claim here is "is ignored", so it is asked of the ignore files.
const escapeRule = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [dir, rules] of [
  [ANDROID, ['*.jks', '*.keystore', 'keystore.properties']],
  [IOS, ['*.mobileprovision', '*.p12', '*.cer', 'ExportOptions.plist']],
]) {
  const path = join(dir, '.gitignore');
  const src = required(path, `${rel(path)} present`);
  if (src === null) continue;
  const missing = rules.filter((r) => !new RegExp(`^${escapeRule(r)}$`, 'm').test(src));
  expect(
    missing.length === 0,
    `${rel(path)} ignores signing material`,
    `no active rule for ${missing.join(', ')} — a commented-out rule does not count. ` +
      `This repository is public; see this script's header.`,
  );
}

// =====================================================================================
// 3. Orientation — and the two settings that make it actually apply on a large screen.
// =====================================================================================
const LANDSCAPE = ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'];
if (infoPlist !== null) {
  for (const key of ['UISupportedInterfaceOrientations', 'UISupportedInterfaceOrientations~ipad']) {
    const got = plistArray(infoPlist, key);
    expect(
      got !== null && got.length === LANDSCAPE.length && LANDSCAPE.every((o) => got.includes(o)),
      `${key} is landscape only`,
      `got ${JSON.stringify(got)}, expected exactly ${JSON.stringify(LANDSCAPE)}`,
    );
  }
  expect(
    plistTrue(infoPlist, 'UIRequiresFullScreen'),
    'UIRequiresFullScreen is set',
    'without it an iPad honours no orientation restriction at all, so the ~ipad list above ' +
      'is advisory and the app can still be presented in portrait',
  );
}
if (manifest !== null) {
  expect(
    /android:screenOrientation="sensorLandscape"/.test(manifest),
    'Android activity is locked to landscape',
    'MainActivity has no android:screenOrientation="sensorLandscape"',
  );
  expect(
    /android:appCategory="game"/.test(manifest),
    'Android declares the game app category',
    'the <application> has no android:appCategory="game". Android 16 (API 36) IGNORES ' +
      'android:screenOrientation on sw600dp+ displays unless an exception applies, and this ' +
      'is the relevant one — without it the lock above silently does nothing on a tablet.',
  );
}

// =====================================================================================
// 4. Platform baseline — the versions Capacitor 8 supports, plus SPM and no CocoaPods.
// =====================================================================================
const variables = required(join(ANDROID, 'variables.gradle'), 'variables.gradle present');
if (variables !== null) {
  for (const [key, want] of [
    ['minSdkVersion', 24],
    ['compileSdkVersion', 36],
    ['targetSdkVersion', 36],
  ]) {
    const m = new RegExp(`${key}\\s*=\\s*(\\d+)`).exec(variables);
    expect(
      m !== null && Number(m[1]) === want,
      `Android ${key} is ${String(want)}`,
      `got ${String(m?.[1])}, expected ${String(want)}`,
    );
  }
}
if (pbx !== null) {
  const targets = [...pbx.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map((m) => m[1]);
  expect(
    targets.length > 0 && targets.every((t) => t === '15.0'),
    'iOS deployment target is 15.0',
    `IPHONEOS_DEPLOYMENT_TARGET values ${JSON.stringify(targets)}, expected all 15.0`,
  );
  expect(
    /CapApp-SPM/.test(pbx),
    'iOS project references the Swift package',
    'project.pbxproj does not reference CapApp-SPM',
  );
  // Capacitor 8 is SPM by default. A CocoaPods setup appearing here would mean someone ran a
  // migration or an older CLI — it would work, but it would silently change how every
  // dependency is resolved and add a lockfile nobody in this repo maintains.
  expect(
    !/\[CP\]|Pods-App\.|libPods/.test(pbx),
    'iOS project has no CocoaPods build phases',
    'project.pbxproj contains CocoaPods references; this project is SPM (Capacitor 8 default)',
  );
}
expect(
  existsSync(join(IOS, 'App', 'CapApp-SPM', 'Package.swift')),
  'the Swift package manifest exists',
  'App/CapApp-SPM/Package.swift is missing',
);
expect(
  !existsSync(join(IOS, 'App', 'Podfile')) && !existsSync(join(IOS, 'App', 'Podfile.lock')),
  'no Podfile is present',
  'a Podfile exists under ios/App; this project is SPM',
);

// =====================================================================================
// 4b. The Gradle include paths still resolve.
//
// `capacitor.settings.gradle` is generated with ABSOLUTE-ish paths into the pnpm store that
// embed the resolved versions — `.pnpm/@capacitor+android@8.5.0_@capacitor+core@8.5.0/...`.
// Both packages are declared `^8.5.0`, so a Dependabot bump or any `pnpm update` relocates
// that directory and leaves the committed path dangling. Gradle then fails on a missing
// project directory, with nothing in the error connecting it to the dependency change, on a
// platform CI never builds — so without this it surfaces whenever someone next opens Android
// Studio. Here it fails in `verify`, on the bump's own PR, naming the one-line fix.
// =====================================================================================
const settingsGradle = required(
  join(ANDROID, 'capacitor.settings.gradle'),
  'capacitor.settings.gradle present',
);
if (settingsGradle !== null) {
  const referenced = [...settingsGradle.matchAll(/new File\('([^']+)'\)/g)].map((m) => m[1]);
  const dangling = referenced.filter((p) => !existsSync(join(ANDROID, p)));
  expect(
    referenced.length > 0 && dangling.length === 0,
    `all ${String(referenced.length)} Gradle include path(s) resolve`,
    `${dangling.join('\n   ')}\n   → These are version-pinned pnpm store paths. A dependency ` +
      `bump invalidates them; regenerate with \`pnpm --filter @wynding/mobile run sync:android\`.`,
  );
}

// =====================================================================================
// 5. No synced web payload is committed. The trees are committed; what `cap sync` COPIES
//    into them is build output and must not be. Asked of git rather than of the ignore
//    files, because "is ignored" and "is not committed" are different claims and this is
//    the one that matters — a force-add beats any ignore rule.
// =====================================================================================
const PAYLOAD = [
  'apps/mobile/ios/App/App/public',
  'apps/mobile/android/app/src/main/assets/public',
  'apps/mobile/ios/App/App/capacitor.config.json',
  'apps/mobile/android/app/src/main/assets/capacitor.config.json',
];
let tracked = null;
try {
  tracked = execFileSync('git', ['ls-files', '--', ...PAYLOAD], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
} catch {
  tracked = null;
}
expect(
  tracked !== null && tracked.length === 0,
  'no synced web payload is committed under either native project',
  tracked === null
    ? 'could not ask git (is this a git checkout?) — this check cannot pass vacuously'
    : `${String(tracked.length)} tracked file(s), e.g. ${tracked.slice(0, 3).join(', ')}`,
);

// =====================================================================================
if (failures.length > 0) {
  console.error(
    `✗ native invariants: ${String(failures.length)} of ${String(failures.length + passed.length)} failed\n`,
  );
  for (const f of failures) console.error(` • ${f}\n`);
  process.exit(1);
}
console.log(
  `✓ native invariants: all ${String(passed.length)} hold across the iOS and Android projects.`,
);
