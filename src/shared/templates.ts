// 需求规格模板:一键把常见出图场景的槽位填好(风格/构图/比例/分辨率/规避项)
// 只填槽位,不代替用户确认 —— 套用模板后需求自动回到「待确认」,仍由用户点头生成

import type { ImageBrief } from './types'

export interface BriefTemplate {
  id: string
  name: string
  emoji: string
  /** 一句话说明适用场景 */
  hint: string
  /** 预填的槽位(不覆盖用户已手动写的 notes/subject,由调用方决定合并策略) */
  brief: Partial<ImageBrief>
  /** 该模板的画面骨架,用于提示词预览与新手上手 */
  skeleton: string
}

export const BRIEF_TEMPLATES: BriefTemplate[] = [
  {
    id: 'avatar',
    name: '头像 / 图标',
    emoji: '🧑',
    hint: '小尺寸也要认得出:居中、留白、别裁头',
    brief: {
      usage: '头像',
      style: '干净棚拍或轻插画,轮廓清晰,适合小尺寸显示',
      composition: '主体居中,四周留白充足,头部完整不裁切,避免复杂背景',
      colorTone: '光线均匀,浅色渐变背景,主体与背景对比明确',
      aspectRatio: '1:1',
      resolution: '1024x1024',
      negativePrompts: '复杂背景、文字、水印、边框、多余肢体'
    },
    skeleton: '主体外貌与表情 → 浅色渐变背景 → 均匀光线 → 居中构图'
  },
  {
    id: 'poster',
    name: '海报主视觉',
    emoji: '🖼',
    hint: '画面里留出加标题的负空间',
    brief: {
      usage: '海报',
      style: '商业主视觉,画面精致,刻意留出版式空间',
      composition: '主体偏侧放置,上方或一侧留出标题负空间,视觉重心落在上三分线',
      colorTone: '主色调统一,明暗层次分明,便于叠加文字',
      aspectRatio: '3:4',
      resolution: '1056x1408',
      negativePrompts: '画面内文字、水印、边框、杂乱装饰、变形肢体'
    },
    skeleton: '主体动作与情绪 → 场景氛围 → 主色调与光影 → 标题负空间位置'
  },
  {
    id: 'ecommerce',
    name: '电商主图',
    emoji: '🛒',
    hint: '产品占画面主体,底部接触阴影,别加字',
    brief: {
      usage: '电商主图',
      style: '产品实拍质感,干净影棚光',
      composition: '产品居中,占画面 70-80%,底部轻微接触阴影,水平对齐,背景纯净',
      colorTone: '纯白或浅灰渐变背景,柔光,高光不过曝',
      aspectRatio: '1:1',
      resolution: '2048x2048',
      negativePrompts: '文字、Logo、水印、边框、倒影错乱、多件产品、杂色背景'
    },
    skeleton: '产品外观细节 → 纯净背景 → 均匀柔光 → 正视角平视'
  },
  {
    id: 'wallpaper',
    name: '壁纸 / 大图',
    emoji: '🌄',
    hint: '大景深、主体避开边缘,适合裁切',
    brief: {
      usage: '壁纸',
      style: '电影感摄影或高细节数字绘画',
      composition: '大景深,主体避开画面边缘,天空/远景有层次可裁切',
      colorTone: '冷暖对比明确,有光源方向感',
      aspectRatio: '16:9',
      resolution: '3840x2160',
      negativePrompts: '文字、水印、边框、重复元素、噪点过重'
    },
    skeleton: '场景主体 → 远景与天空层次 → 光影与主色调 → 广角构图'
  },
  {
    id: 'social',
    name: '社交配图',
    emoji: '📱',
    hint: '中心构图 + 安全区,裁切到哪都能看',
    brief: {
      usage: '社交配图',
      style: '明快插画或干净摄影,信息一眼可读',
      composition: '中心主体,四周留白做裁切安全区,元素不贴边',
      colorTone: '明亮通透,主色不超过三种',
      aspectRatio: '4:3',
      resolution: '2048x2048',
      negativePrompts: '文字、水印、边框、密集小元素'
    },
    skeleton: '主体与动作 → 简洁背景 → 明快色调 → 留白安全区'
  },
  {
    id: 'guochao',
    name: '国潮插画',
    emoji: '🐉',
    hint: '平面化 + 纹样环绕 + 朱红青绿金箔',
    brief: {
      usage: '插画 / 海报',
      style: '国潮插画,工笔线条,金箔点缀,平面化处理',
      composition: '对称或斜向排布,祥云/回纹环绕主体,画面饱满但不杂乱',
      colorTone: '朱红、青绿为主,金箔点缀,底色沉稳',
      aspectRatio: '3:4',
      resolution: '1056x1408',
      negativePrompts: '照片写实、杂乱纹理、文字、水印、边框'
    },
    skeleton: '主体与姿态 → 传统纹样与祥云环绕 → 朱红/青绿/金箔配色 → 平面化构图'
  }
]

export function findTemplate(id: string): BriefTemplate | undefined {
  return BRIEF_TEMPLATES.find((t) => t.id === id)
}
