const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');

test('repository and package metadata credit PROcrush', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const license = fs.readFileSync(path.join(projectRoot, 'LICENSE'), 'utf8');
  const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
  const readmeZh = fs.readFileSync(path.join(projectRoot, 'README.zh-CN.md'), 'utf8');

  assert.equal(pkg.version, '1.4.4');
  assert.match(pkg.author, /PROcrush/);
  assert.match(pkg.description, /created by PROcrush/);
  assert.match(pkg.build.copyright, /PROcrush/);
  assert.match(pkg.build.mac.extendInfo.NSHumanReadableCopyright, /PROcrush/);
  assert.match(pkg.build.win.legalTrademarks, /PROcrush/);
  assert.match(license, /Copyright \(c\) 2026 PROcrush and contributors/);
  assert.match(readme, /Created and maintained by \[PROcrush\]/);
  assert.match(readmeZh, /由 \[PROcrush\].*创建并维护/);
});

test('desktop UI and About panel visibly credit PROcrush', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'styles.css'), 'utf8');
  const main = fs.readFileSync(path.join(projectRoot, 'src', 'main.cjs'), 'utf8');

  assert.match(html, /class="brand-credit">Created by PROcrush</);
  assert.match(html, /<title>PRO DJ LINK Monitor — PROcrush<\/title>/);
  assert.match(styles, /\.brand-credit\s*\{/);
  assert.match(main, /APP_CREATOR = 'PROcrush'/);
  assert.match(main, /setAboutPanelOptions/);
  assert.match(main, /Created by \$\{APP_CREATOR\}/);
});
