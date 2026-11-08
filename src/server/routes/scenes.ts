import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import { asObject, BadInput, reqString } from '../../contracts/input';
import { api } from '../http';
import { getSceneDay, localDayRange, scheduleSceneDay } from '../scenes/day';
import { activeTemplates } from '../scenes/templates';

export function registerSceneRoutes(app: WorkbenchServer): void {
  app.route('GET', '/api/scenes', api((context) => {
    const day = context.url.searchParams.get('day');
    if (!day) throw new BadInput('请选择日期');
    return getSceneDay(context.database, localDayRange(day));
  }));
  app.route('POST', '/api/scenes/rebuild', api((context) => {
    const range = localDayRange(reqString(asObject(context.body), 'day', 10));
    const day = getSceneDay(context.database, range);
    if (day.transcribedCount === 0) throw new BadInput('这一天还没有转录完成的录音');
    return { ...scheduleSceneDay(context.database, context.host, range), day: range.day };
  }));
  app.route('GET', '/api/templates', api((context) => activeTemplates(context.database)));
}
