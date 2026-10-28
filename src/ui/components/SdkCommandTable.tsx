// ABOUTME: SDK 指令库表格，只读展示 memotalk-ble-skill 的协议指令。

import { Activity } from 'lucide-react';
import type { SdkCommand } from '../../contracts/app';
import { Card, Empty } from './ui';

export function SdkCommandTable({ commands }: { commands: SdkCommand[] }) {
  return (
    <Card title="SDK 指令库" action={<span className="muted">{commands.length} 条 · 来自 memotalk-ble-skill</span>}>
      {commands.length === 0 ? (
        <Empty title="没有指令数据" />
      ) : (
        <div className="cmdtable">
          <div className="cmdtable__head">
            <span>指令</span>
            <span>名称</span>
            <span className="col-channel">通道</span>
            <span>请求帧 / 参数</span>
            <span className="col-response">应答规则</span>
          </div>
          <ul>
            {commands.map((command) => (
              <li key={command.cmdCode} className="cmdtable__row">
                <span className="cmdtable__code">{command.cmdCode}</span>
                <span className="cmdtable__name">
                  {command.name}
                  {command.caution ? <span className="warn-badge">需确认</span> : null}
                </span>
                <span className="col-channel">
                  <span className={`channel channel--${command.channel.toLowerCase()}`}>{command.channel}</span>
                </span>
                <span className="cmdtable__hex">{command.requestHex}</span>
                <span className="col-response">{command.responseRule}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="muted cmdtable__foot">
        <Activity size={13} aria-hidden="true" /> 指令定义来自 SDK 协议文档；本应用只自动执行「读取清单」与「下载文件」两条安全流程。
      </p>
    </Card>
  );
}
