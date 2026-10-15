// Checks allowKey in server/tasks.ts and server/mcp-stdio.mjs agree and match expected rules.
// Run: node scripts/check-allow-key.mjs
import { readFileSync } from 'node:fs';

/** Pulls allowKey (plus the tool sets it uses) out of a source file, stripping TS annotations. */
function load(file) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const grab = (re) => src.match(re)[0];
  const code = [
    grab(/const MULTI_COMMAND_TOOLS = [\s\S]*?\]\);/),
    grab(/const WRAPPER_TOOLS = [\s\S]*?\]\);/),
    grab(/function allowKey\([\s\S]*?\n\}/)
      .replace('(toolName: string, input: Record<string, unknown>): string | null', '(toolName, input)'),
    'return allowKey;',
  ].join('\n');
  return new Function(code)();
}

const bash = (command) => ['Bash', { command }];
const cases = [
  [bash('cd x && rm -rf ~'), null],
  [bash('cd x; rm -rf ~'), null],
  [bash('ls | sh'), null],
  [bash('ls & rm -rf ~'), null],
  [bash('echo $(whoami)'), null],
  [bash('echo `whoami`'), null],
  [bash('echo hi > ~/.bashrc'), null],
  [bash('cat < /etc/passwd'), null],
  [bash('ls\nrm -rf ~'), null],
  [bash('git status'), 'Bash:git status'],
  [bash('git status --short'), 'Bash:git status'],
  [bash('git push --force'), 'Bash:git push'],
  [bash('git -C /tmp push'), 'Bash:git -C /tmp push'],
  [bash('git'), 'Bash:git'],
  [bash('/usr/bin/git push'), 'Bash:/usr/bin/git push'],
  [bash('npm test'), 'Bash:npm test'],
  [bash('ls -la'), 'Bash:ls'],
  [bash('  ls   -la '), 'Bash:ls'],
  [bash('bash -c "rm -rf ~"'), 'Bash:bash -c "rm -rf ~"'],
  [bash('FOO=1 rm -rf ~'), 'Bash:FOO=1 rm -rf ~'],
  [bash('   '), null],
  [['Edit', { file_path: 'x' }], 'Edit'],
];

const impls = { 'server/tasks.ts': load('server/tasks.ts'), 'server/mcp-stdio.mjs': load('server/mcp-stdio.mjs') };
let failed = 0;
for (const [file, allowKey] of Object.entries(impls)) {
  for (const [[tool, input], expected] of cases) {
    const got = allowKey(tool, input);
    if (got !== expected) {
      failed++;
      console.log(`FAIL ${file}: ${JSON.stringify(input)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }
  }
}
// A legacy `Bash:git` rule must not match anything but bare `git`.
if (impls['server/tasks.ts'](...bash('git push --force')) === 'Bash:git') failed++;
console.log(failed ? `${failed} failure(s)` : `all ${cases.length} cases pass in both files`);
process.exit(failed ? 1 : 0);
