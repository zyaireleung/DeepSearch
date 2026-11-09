// lib/ov-timeline-map.js
/** OV 领域事件 → 时间线事件形状。纯函数，无 IO，不 import server / ov-import。 */
export function mapOvEvent(e) {
  return {
    type: 'import',
    subtype: 'OV 导入',
    title: '导入完成',
    fields: {
      完成情况: `${e.outcome}（成功 ${e.done}/${e.plannedTotal}，失败 ${e.failed}）`,
      完成时间: new Date().toLocaleString('zh-CN', { hour12: false }),
    },
  };
}
