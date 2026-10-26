"""Real Git/Gitleaks regressions; no network, real credentials, or main-index changes."""

import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CONTROL_FILES = ('.gitignore', '.gitleaks.toml', '.githooks/pre-commit', '.env.example')


class GitGuardTests(unittest.TestCase):
    def test_commit_boundaries(self):
        self.assertIsNotNone(shutil.which('git'), 'Git is required')
        self.assertIsNotNone(shutil.which('gitleaks'), 'Gitleaks is required')
        cases = (
            ('clean_initial_commit', None),
            ('staged_secret_with_weak_worktree_config', b'rule=truebuild-model-api-key-assignment'),
            ('indexed_ignore_with_empty_worktree_ignore', b'matches a .gitignore rule'),
            ('nested_indexed_ignore_with_empty_worktree_ignore', b'matches a .gitignore rule'),
            ('binary_attribute_secret', b'rule=truebuild-model-api-key-assignment'),
            ('nul_prefixed_secret', b'rule=truebuild-model-api-key-assignment'),
            ('neutral_filename_scan', b'rule=truebuild-model-api-key-assignment'),
            ('mixed_case_private_document', b'personal application document'),
            ('clean_index_with_dirty_worktree_secret', None),
            ('unsafe_indexed_config', b'built-in rules must remain enabled'),
            ('fullwidth_media_extension', b'raw media'),
            ('copied_private_document', b'personal application document'),
            ('unnamespaced_custom_rule', b'custom rule IDs must use the truebuild- prefix'),
            ('staged_ignore_removal_allows_generated', None),
            ('staged_ignore_removal_keeps_private_backstop', b'dotenv file'),
            ('tooling_privacy_ignores', b'matches a .gitignore rule'),
            ('root_readme_and_test_specs', None),
            ('nested_readme', b'documentation policy'),
            ('alternate_root_readme', b'documentation policy'),
            ('auxiliary_markdown', b'documentation policy'),
            ('planning_directory', b'documentation policy'),
            ('specification_document', b'documentation policy'),
            ('documentation_with_removed_ignore', b'documentation policy'),
            ('unicode_readme_alias', b'documentation policy'),
            ('secret_in_root_readme', b'rule=truebuild-model-api-key-assignment'),
            ('office_plan_docx', b'documentation policy'),
            ('office_requirements_rtf', b'documentation policy'),
            ('spreadsheet_spec_csv', b'documentation policy'),
            ('symlink_root_readme', b'root README.md must be a regular file'),
            ('office_private_application', b'personal application document'),
        )
        for case, block_cause in cases:
            allowed = block_cause is None
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix='truebuild-guard-test-') as temp:
                repo = Path(temp) / 'repo'
                repo.mkdir()
                env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
                env.update(
                    GIT_CONFIG_GLOBAL=os.devnull,
                    GIT_CONFIG_SYSTEM=os.devnull,
                    GIT_CONFIG_NOSYSTEM='1',
                    GIT_AUTHOR_NAME='Synthetic Test',
                    GIT_AUTHOR_EMAIL='test@example.invalid',
                    GIT_COMMITTER_NAME='Synthetic Test',
                    GIT_COMMITTER_EMAIL='test@example.invalid',
                )

                def git(*args, check=True):
                    return subprocess.run(
                        ['git', *args], cwd=repo, env=env, capture_output=True, check=check, timeout=30,
                    )

                def write(name, content):
                    path = repo / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content.encode() if isinstance(content, str) else content)

                git('init', '-b', 'main')
                for name in CONTROL_FILES:
                    write(name, (ROOT / name).read_bytes())
                (repo / '.githooks/pre-commit').chmod(0o755)
                git('config', '--local', 'core.hooksPath', '.githooks')
                git('config', '--local', 'commit.gpgsign', 'false')
                write('README.md', '# Synthetic project\n')
                git('add', '--', 'README.md')
                git('add', '--', *CONTROL_FILES)
                token = secrets.token_hex(24)
                credential = 'MODEL_API_KEY=' + token + '\n'

                if case == 'staged_secret_with_weak_worktree_config':
                    write('source.ts', credential)
                    git('add', '--', 'source.ts')
                    write('.gitleaks.toml', '[[rules]]\nid="weak"\nregex="never-matches-this-fixture"\n')
                elif case == 'indexed_ignore_with_empty_worktree_ignore':
                    write('node_modules/source.ts', 'export const value = 1\n')
                    git('add', '-f', '--', 'node_modules/source.ts')
                    write('.gitignore', '')
                elif case == 'nested_indexed_ignore_with_empty_worktree_ignore':
                    write('nested/.gitignore', 'generated/\n')
                    write('nested/generated/source.ts', 'export const value = 1\n')
                    git('add', '-f', '--', 'nested/.gitignore', 'nested/generated/source.ts')
                    write('nested/.gitignore', '')
                elif case == 'binary_attribute_secret':
                    write('.gitattributes', '*.ts -diff\n')
                    write('source.ts', credential)
                    git('add', '--', '.gitattributes', 'source.ts')
                elif case == 'nul_prefixed_secret':
                    write('source.ts', b'\0' + credential.encode())
                    git('add', '--', 'source.ts')
                elif case == 'neutral_filename_scan':
                    write('source.svg', credential)
                    git('add', '--', 'source.svg')
                elif case == 'mixed_case_private_document':
                    write('.gitignore', '')
                    git('add', '--', '.gitignore')
                    write('docs/META-HACKATHON-APPLICATION.MD', 'Private application fixture\n')
                    git('add', '-f', '--', 'docs/META-HACKATHON-APPLICATION.MD')
                elif case == 'clean_index_with_dirty_worktree_secret':
                    write('source.ts', 'export const value = 1\n')
                    git('add', '--', 'source.ts')
                    write('source.ts', credential)
                elif case == 'unsafe_indexed_config':
                    write('.gitleaks.toml', '[extend]\nuseDefault=false\n')
                    git('add', '--', '.gitleaks.toml')
                elif case == 'fullwidth_media_extension':
                    write('capture.ｐｎｇ', b'\0Synthetic raw capture fixture\n')
                    git('add', '-f', '--', 'capture.ｐｎｇ')
                elif case == 'copied_private_document':
                    write('scratch/META-HACKATHON-PASTE-READY.MD', 'Private application fixture\n')
                    git('add', '-f', '--', 'scratch/META-HACKATHON-PASTE-READY.MD')
                elif case == 'unnamespaced_custom_rule':
                    config = (ROOT / '.gitleaks.toml').read_text()
                    write('.gitleaks.toml', config.replace('truebuild-model-api-key-assignment', 'custom-assignment'))
                    git('add', '--', '.gitleaks.toml')
                elif case.startswith('staged_ignore_removal_'):
                    write('.gitignore', 'generated/\n')
                    git('add', '--', '.gitignore')
                    write('.gitignore', '')
                    git('add', '--', '.gitignore')
                    name = 'generated/source.ts' if allowed else '.env'
                    write(name, 'Synthetic nonsecret fixture\n')
                    git('add', '-f', '--', name)
                elif case == 'tooling_privacy_ignores':
                    names = (
                        'test-results/trace.data',
                        'playwright-report/index.html',
                        'android/local.properties',
                        'ios/App.xcodeproj/xcuserdata/reviewer.xcuserdatad/state.data',
                    )
                    for name in names:
                        self.assertTrue(
                            git('check-ignore', '--no-index', '--', name, check=False).returncode == 0,
                            f'{case}: missing ignore for {name}',
                        )
                    write(names[0], 'Synthetic tooling fixture\n')
                    git('add', '-f', '--', names[0])
                elif case == 'root_readme_and_test_specs':
                    name = 'tests/workflow.spec.ts'
                    write(name, 'export const fixture = true\n')
                    self.assertEqual(git('check-ignore', '--no-index', '--', name, check=False).returncode, 1)
                    git('add', '--', name)
                elif case == 'secret_in_root_readme':
                    write('README.md', credential)
                    git('add', '--', 'README.md')
                elif case == 'symlink_root_readme':
                    write('source.ts', 'export const fixture = true\n')
                    (repo / 'README.md').unlink()
                    (repo / 'README.md').symlink_to('source.ts')
                    git('add', '--', 'README.md', 'source.ts')
                elif case == 'office_private_application':
                    name = 'scratch/META-HACKATHON-APPLICATION.DOCX'
                    write(name, 'Synthetic private application fixture\n')
                    git('add', '-f', '--', name)
                elif case in {
                    'nested_readme', 'alternate_root_readme', 'auxiliary_markdown', 'planning_directory',
                    'specification_document', 'documentation_with_removed_ignore', 'unicode_readme_alias',
                    'office_plan_docx', 'office_requirements_rtf', 'spreadsheet_spec_csv',
                }:
                    names = {
                        'nested_readme': 'gate-check/README.md',
                        'alternate_root_readme': 'README.txt',
                        'auxiliary_markdown': 'SECURITY.md',
                        'planning_directory': 'nested/PLANS/implementation.json',
                        'specification_document': 'implementation-spec.yaml',
                        'documentation_with_removed_ignore': 'docs/design.json',
                        'unicode_readme_alias': 'nested/ＲＥＡＤＭＥ.txt',
                        'office_plan_docx': 'implementation-plan.docx',
                        'office_requirements_rtf': 'requirements.rtf',
                        'spreadsheet_spec_csv': 'design-spec.csv',
                    }
                    name = names[case]
                    write(name, 'Synthetic local document\n')
                    if case == 'documentation_with_removed_ignore':
                        write('.gitignore', '')
                        git('add', '--', '.gitignore')
                    git('add', '-f', '--', name)

                result = git('commit', '-m', 'Synthetic guard check', check=False)
                output = result.stdout + result.stderr
                self.assertFalse(
                    any(fragment.encode() in output for fragment in (token, token[:12], token[-12:])),
                    f'{case}: credential value or fragment was printed',
                )
                self.assertEqual(result.returncode == 0, allowed, f'{case}: unexpected commit outcome')
                if block_cause is not None:
                    self.assertTrue(block_cause in output, f'{case}: expected sanitized block cause was absent')
                if case in {'copied_private_document', 'office_private_application'}:
                    private_name = ('scratch/META-HACKATHON-PASTE-READY.MD'
                                    if case == 'copied_private_document'
                                    else 'scratch/META-HACKATHON-APPLICATION.DOCX')
                    self.assertTrue(
                        git('check-ignore', '--no-index', '--', private_name,
                            check=False).returncode == 0,
                        f'{case}: copied private basename was not ignored',
                    )
                head_exists = git('rev-parse', '--verify', 'HEAD', check=False).returncode == 0
                self.assertEqual(head_exists, allowed, f'{case}: unexpected HEAD state')


if __name__ == '__main__':
    unittest.main()
