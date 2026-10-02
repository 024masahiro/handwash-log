import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
console.log('Ready for source credential JSON on stdin (input is hidden).');
let input = '';
for await (const chunk of process.stdin) {
  input += chunk.toString();
  if (!input.includes('\n')) continue;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  const credential = JSON.parse(input.trim()); input = '';
  if (!credential.token || !credential.remote_url?.startsWith('https://') || !credential.branch || credential.auth_mode !== 'http_extra_header') throw new Error('Unsupported source credential');
  const environment = { ...process.env, GIT_TERMINAL_PROMPT:'0' };
  const count = Number(environment.GIT_CONFIG_COUNT || 0);
  environment.GIT_CONFIG_COUNT = String(count + 1);
  environment['GIT_CONFIG_KEY_' + count] = 'http.extraHeader';
  environment['GIT_CONFIG_VALUE_' + count] = 'Authorization: Bearer ' + credential.token;
  function git(args, allowed = [0]) {
    const result = spawnSync('git', args, { cwd:process.cwd(), env:environment, encoding:'utf8', timeout:60000 });
    if (!allowed.includes(result.status)) throw new Error((result.stderr || 'Git command failed').replaceAll(credential.token, '[redacted]'));
    return result;
  }
  if (!existsSync('.git')) git(['init', '-b', credential.branch]);
  const existing = git(['remote', 'get-url', 'origin'], [0,2,128]);
  if (existing.status !== 0) git(['remote', 'add', 'origin', credential.remote_url]);
  else if (existing.stdout.trim() !== credential.remote_url) throw new Error('Source remote differs from registered Site');
  git(['add', '.']);
  const changes = git(['diff', '--cached', '--quiet'], [0,1]);
  if (changes.status === 1 || git(['rev-parse', '--verify', 'HEAD'], [0,128]).status !== 0) git(['commit', '-m', 'Restrict handwash records to verified staff accounts']);
  git(['push', 'origin', 'HEAD:refs/heads/' + credential.branch]);
  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  const remote = git(['ls-remote', 'origin', 'refs/heads/' + credential.branch]).stdout.split(/\s/)[0];
  if (sha !== remote) throw new Error('Pushed source verification failed');
  console.log(JSON.stringify({ commit_sha:sha, pushed:true }));
  delete environment['GIT_CONFIG_VALUE_' + count];
  process.exit(0);
}
