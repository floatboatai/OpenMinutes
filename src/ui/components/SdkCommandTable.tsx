// ABOUTME: 设备协议指令参考表（开发者），只读展示设备 SDK（memotalk-sdk）的协议指令；只在诊断区出现。

import { Activity } from 'lucide-react';
import type { SdkCommand } from '../../contracts/app';
import { Empty } from './ui';

export function SdkCommandTable({ commands }: { commands: SdkCommand[] }) {
  return (
    <div className="cmdtable-wrap">
      <p className="muted">{commands.length} 条 · 来自设备 SDK（memotalk-sdk）</p>
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
        <Activity size={13} aria-hidden="true" /> 本应用只自动执行连接、读取状态与清单、校时、下载，以及删除已同步且校验一致的录音。
      </p>
    </div>
  );
}
