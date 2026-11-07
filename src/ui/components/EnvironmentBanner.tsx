// ABOUTME: 本机环境有失败项时的提示条；只是跳转到「设置 › 诊断与高级」，本身不执行修复。

import { CircleAlert } from 'lucide-react';

export function EnvironmentBanner({ failCount }: { failCount: number }) {
  if (failCount <= 0) return null;
  return (
    <div className="envbanner" role="status">
      <CircleAlert size={15} aria-hidden="true" />
      <span>本机有 {failCount} 项组件还没准备好，部分功能可能用不了。</span>
      <a className="linkbtn" href="#/settings/diagnostics">
        去诊断与修复
      </a>
    </div>
  );
}
