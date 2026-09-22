// @vitest-environment happy-dom
/**
 * 颜色类必须与 stateCheck.ts 的 StateCheckTone（success/danger/neutral）同名。
 *
 * 为什么不能只断言 DOM 上的 className：vitest 对 CSS module 返回代理，任何键都会
 * 字符串化（styles.nope 也是字符串），所以 "类名非空" 抓不到「SCSS 里没有这条规则」。
 * 那个 bug 正是这样漏掉的：tone 返回 'success' 而 SCSS 只定义了 .good，
 * styles['success'] 在运行时是 undefined，State 形状完全没有颜色。
 *
 * 因此这里直接读 SCSS 源码，确认三个色调类真的存在。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const scssPath = resolve(__dirname, '../TurnStateMergedTable.module.scss');
const source = readFileSync(scssPath, 'utf-8');

it.each(['success', 'danger', 'neutral'])('defines the .%s tone class used by StateCheckTone', (tone) => {
  // 顶格选择器，避免匹配到 .toneSuccess 之类的近似名。
  expect(source).toMatch(new RegExp(`^\\.${tone}\\s*\\{`, 'm'));
});

it('does not rely on a differently-named success alias', () => {
  // 曾经这里写的是 .good，而 tone 值是 success —— 两者并存说明又漂移了。
  expect(source).not.toMatch(/^\.good\s*\{/m);
});

it('gives success and danger different colors so a mismatch is visible', () => {
  const colorOf = (tone: string) => source.match(new RegExp(`^\\.${tone}\\s*\\{[^}]*color:\\s*([^;]+);`, 'm'))?.[1]?.trim() ?? '';
  const success = colorOf('success');
  const danger = colorOf('danger');
  expect(success).not.toBe('');
  expect(danger).not.toBe('');
  expect(success).not.toBe(danger);
});
