// 样本越多，对绿色状态的成功率要求越高；10 次以内以 90% 为基线，1000 次后封顶 99%。
export function healthGreenThreshold(total: number): number {
  return Math.min(0.99, 0.9 + 0.045 * Math.max(0, Math.log10(total / 10)));
}

// 上游模型一致率的分段色调：>=90 绿 / 60-89 橙 / <60 红。
// null 表示无可用样本，必须保持中性，绝不能降级成红色的 0%。
export type UpstreamMatchTone = 'success' | 'warning' | 'danger' | 'neutral';

export const upstreamModelMatchTone = (percent: number | null): UpstreamMatchTone => {
  if (percent === null || !Number.isFinite(percent)) {
    return 'neutral';
  }
  if (percent >= 90) {
    return 'success';
  }
  if (percent >= 60) {
    return 'warning';
  }
  return 'danger';
};
