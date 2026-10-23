"""Create an explicitly unsigned widget and a reproducible source handoff."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
artifacts = root / 'artifacts'
artifacts.mkdir(exist_ok=True)

def archive(destination, files, base, prefix=''):
    with ZipFile(destination, 'w', ZIP_DEFLATED) as output:
        for file in sorted(files):
            if file.is_file():
                output.write(file, prefix + str(file.relative_to(base)))

archive(artifacts / 'ReolinkTV-unsigned.wgt', (root / 'dist').rglob('*'), root / 'dist')
source_files = []
for folder in ['app', 'native', 'scripts', 'tests', 'docs']:
    # Keep browser QA captures local; ship the written setup and validation guides.
    source_files.extend((root / folder).rglob('*.md' if folder == 'docs' else '*'))
source_files.extend(root / name for name in ['package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore'])
source_files.append(artifacts / 'ReolinkTV-unsigned.wgt')
archive(artifacts / 'ReolinkTV-source.zip', source_files, root, 'reolink-tv/')
print('Created artifacts/ReolinkTV-unsigned.wgt (requires Samsung signing before installation).')
print('Created artifacts/ReolinkTV-source.zip (source, bundled player, tests, docs, unsigned widget).')
