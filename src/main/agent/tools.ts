// 工具定义(function calling schema)与执行器

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nativeImage } from 'electron'
import type { AgentEvent, ImageAsset, ImageBrief } from '@shared/types'
import { BRIEF_SLOTS } from '@shared/types'
import { buildConstraintClause } from '@shared/promptCompiler'
import { computeCost } from '@shared/cost'
import {
  alphaBBox,
  autoCutout,
  cropImage,
  cutoutWithMask,
  drawGrid,
  expandCanvas,
  gridImages,
  normRectToPixels,
  parseColor,
  pasteImage,
  rectText,
  recolor,
  roundCorners,
  type RgbaImage
} from '@shared/composite'
import {
  applyEditGuard,
  compareWithBaseline,
  guardSummary,
  paintRegion,
  type EditGuardReport,
  type GuardRect
} from '@shared/fidelity'
import { decodeRgba, encodeRgba, guardSize } from '../imageops'
import { getDb } from '../store/db'
import { getSettings } from '../store/settings'
import { readAssetBuffer, saveBufferAsset } from '../store/assets'
import { describeDropped, editImage, generateImages, guessMime, parseExplicitSize } from '../providers/images'
import type { GeneratedImages } from '../providers/images'
import type { LLMTool } from '../providers/chat'
import { errText } from '../providers/http'

export const TOOL_DEFS: LLMTool[] = [
  {
    type: 'function',
    function: {
      name: 'update_brief',
      description:
        '更新需求规格(填槽)。每当用户给出新信息就调用一次,只传需要更新的槽位。confirmed 参数仅在用户明确同意需求摘要后才可设为 true,绝不能自作主张设为 true。',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '主体:画什么(人物/物体/场景)' },
          style: { type: 'string', description: '风格:摄影/插画/3D/水彩/国潮…' },
          composition: { type: 'string', description: '构图:视角、景别、布局' },
          colorTone: { type: 'string', description: '色调氛围' },
          aspectRatio: { type: 'string', description: '画面比例,取值:1:1 | 16:9 | 9:16 | 4:3 | 3:4' },
          resolution: { type: 'string', description: '输出分辨率 WxH,如 1024x1024 / 2048x2048 / 3840x2160(生成前必须明确;结合用途建议:头像/图标 1024、社交配图 2048、壁纸 3840)' },
          usage: { type: 'string', description: '用途:头像/海报/壁纸…' },
          negativePrompts: { type: 'string', description: '要避免的元素' },
          notes: { type: 'string', description: '其他补充说明' },
          confirmed: { type: 'boolean', description: '用户明确同意后设为 true' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        '文生图,支持参考图融合。必须等需求规格 confirmed 为 true 之后才能调用。prompt 要融合需求规格全部有效信息,具体、有画面感。当用户提供了多张参考图(如"把三张图里的角色放到同一张图")时,必须通过 referenceAssetIds 传入这些图片,模型会将参考图中的元素融入新图。首图或大改时建议用 variants=3 一次出 3 张候选,再让用户挑选,命中率更高。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '完整的图像生成提示词;带参考图时应说明各参考图元素如何安排' },
          aspectRatio: { type: 'string', description: '画面比例,默认取需求规格中的值' },
          size: { type: 'string', description: '输出分辨率 WxH(如 2048x2048 / 3840x2160),优先于比例;生图前分辨率必须明确' },
          n: { type: 'number', description: '单次生成张数 1-4,默认 1' },
          variants: {
            type: 'number',
            description: '候选数量 2-4:一次生成多张不同候选供用户挑选(首图/大改时推荐 3);候选在用户选用前不算正式版本'
          },
          quality: {
            type: 'string',
            enum: ['auto', 'low', 'medium', 'high'],
            description: '画质档位,覆盖模型默认设置;细节要求高时用 high(更慢更贵),不确定用 auto'
          },
          referenceAssetIds: {
            type: 'array',
            items: { type: 'string' },
            description: '参考图资产 ID 列表(可选,最多 16 张,PNG/JPG/WebP,单张 ≤25MB):把这些图中的角色/风格/元素融合进新图'
          }
        },
        required: ['prompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_image',
      description:
        '基于已有图片编辑(图生图):单图修改、蒙版局部重绘、或多张图融合。用户要求"改背景/换颜色/合成/融合"等连续修图时使用。用户涂抹了蒙版时必须传 maskAssetId。' +
        '只让模型改一处时,必须传 protect:可以用 region/maskAssetId 圈定,也可以 auto:true 让护栏自己判断(把模型改动切成连通块,留下成片的换色/换材质,还原桌面纹理这类零散噪点)。结果会自动以用户最初上传的原图为基线合成,允许区域外逐像素保持原样,并回报"区域外改动 / 边界锚定率"。' +
        '要改的是"材质本身"(白色键帽变黑色键帽、金属变塑料、亮面变哑光)时必须走本工具,不要用 paint —— paint 只能改颜色,改不了材质。',
      parameters: {
        type: 'object',
        properties: {
          assetIds: {
            type: 'array',
            items: { type: 'string' },
            description: '源图片 ID 列表(1-16 张);多张表示融合这些图'
          },
          instruction: { type: 'string', description: '编辑指令:完整描述修改/融合后的画面效果' },
          maskAssetId: { type: 'string', description: '蒙版图片 ID(用户涂抹的区域),仅单源图时可选' },
          protect: {
            type: 'object',
            description:
              '保真模式(单源图,强烈建议用于"只改某处"):只在允许区域应用模型结果,区域外取原图,并自动跟基线比对。允许区域可以是 region / maskAssetId,或者 auto:true。',
            properties: {
              region: {
                type: 'object',
                description: '允许改动的矩形(0-1 归一化)',
                properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }
              },
              maskAssetId: { type: 'string', description: '允许改动的蒙版图(白色/不透明=可以改),尺寸会自动对齐' },
              auto: {
                type: 'boolean',
                description:
                  '自动护栏(不知道坐标时用这个):不给 region/mask 时,自动把模型改动切成连通块,只保留成片的改动,零散噪点还原成原图。换键帽颜色、换材质这类整片改动适合它;被保护的东西(徽标/屏幕/文字)如果恰好也在同一片里就保护不到,这种要改用 region/mask。'
              },
              baselineAssetId: { type: 'string', description: '比对基线;默认=该图版本链的根(用户最初上传的原图)' },
              featherPx: { type: 'number', description: '区域边缘羽化像素,默认 3' },
              minAnchor: { type: 'number', description: '边界锚定率阈值 0-1,默认 0.72;低于它标记"保真可疑"' }
            }
          },
          aspectRatio: { type: 'string', description: '输出比例,默认与源图一致' },
          size: { type: 'string', description: '输出分辨率 WxH(可选):默认沿用源图尺寸,扩图/保持构图时不要传' },
          quality: {
            type: 'string',
            enum: ['auto', 'low', 'medium', 'high'],
            description: '画质档位,覆盖模型默认设置;细节要求高时用 high(更慢更贵),不确定用 auto'
          }
        },
        required: ['assetIds', 'instruction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        '写入文件(覆盖已有内容;目录不存在会自动创建)。用于创建/更新项目文件,如把新确认的要求补充进 要求.md、输出提示词文档等。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径(项目文件放在当前项目文件夹内)' },
          content: { type: 'string', description: '完整文件内容(整体覆盖)' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '精确编辑文本文件:把 oldText 替换为 newText(oldText 必须与文件内容完全一致,含空格换行)。适合小改动,不必重写整个文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          oldText: { type: 'string', description: '要被替换的原文本(需与文件内容精确匹配)' },
          newText: { type: 'string', description: '替换后的新文本(传空字符串即删除)' }
        },
        required: ['path', 'oldText', 'newText']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'composite_image',
      description:
        '本地合成(不调用生图服务,¥0,像素级精确,可重复):抠图/去背景、给底图贴图、局部换色、裁剪、圆角描边、多图拼接。凡是"必须保持原件像素、不能重新画"的活都用它 —— 例如把用户自己的 logo/键帽/包装贴回生成图、把主体从背景里抠出来、只把某块区域改成浅灰、加圆角描边、拼九宫格。需要重新绘制内容、改构图、换风格时用 edit_image。所有矩形坐标都是 0-1 归一化比例(相对当前底图),执行顺序固定:裁剪 → 抠图 → 贴图 → 调色 → 圆角 → 画布尺寸。贴图前若不确定位置,先用 inspect_grid 拿带网格的参考图再定坐标。只看清细节而临时裁剪的图请传 inspect:true,它不会进入版本树。',
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string', description: '底图 ID(asset-xxx)' },
          label: { type: 'string', description: '这次合成的一句话说明,显示在版本名上,如"贴回原件键帽并整体调暗"' },
          inspect: {
            type: 'boolean',
            description:
              '仅用于"为了看清细节而裁剪/放大"的分析图:产物标记为标注图,不进版本树、不占版本链。正式交付的合成结果不要传。'
          },
          crop: {
            type: 'object',
            description: '裁剪:保留这块区域(0-1 归一化)',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' }
            }
          },
          cutout: {
            type: 'object',
            description:
              '抠图/去背景(像素级,不重绘)。不传 maskAssetId = 自动抠(适合纯色/干净背景);背景复杂(真实照片、有投影、主体与背景同色)时,先用 edit_image 只生成一张黑白剪影蒙版(白=主体,黑=背景),再把那张蒙版的 assetId 传进 maskAssetId,这样最终像素完全来自原图。',
            properties: {
              maskAssetId: { type: 'string', description: '黑白蒙版图 ID(白/亮=保留,黑=去掉);省略=自动抠背景。蒙版尺寸不必与原图一致,内部会缩放对齐' },
              invertMask: { type: 'boolean', description: '蒙版反了(黑=主体)时置 true;不传则按边框亮度自动判断' },
              tolerance: { type: 'number', description: '自动抠图的颜色容差 4-120,默认 30;抠掉了主体细节就调小,背景漏进来就调大' },
              edgePercent: { type: 'number', description: '强边缘分位阈值 0.5-0.99,默认 0.9;调低=更多像素被视为轮廓墙(抠得更紧)' },
              background: { type: 'string', description: '铺底色,如 #ffffff / #f2f2f2;省略=透明背景 PNG' },
              trim: { type: 'boolean', description: '裁到主体边缘(留少许边距),去掉四周多余空白' },
              featherPx: { type: 'number', description: '边缘羽化半径(像素),省略按图大小自适应' }
            }
          },
          paste: {
            type: 'object',
            description: '贴图:把另一张图的一块贴到底图上',
            properties: {
              assetId: { type: 'string', description: '要贴上去的图 ID' },
              from: {
                type: 'object',
                description: '从素材图取哪块(0-1);省略则自动取不透明主体(适合抠图 PNG)',
                properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }
              },
              to: {
                type: 'object',
                description: '贴到底图的哪个矩形(0-1),会被拉伸到该矩形',
                properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
                required: ['x', 'y', 'w', 'h']
              },
              opacity: { type: 'number', description: '透明度 0-1,默认 1' },
              blend: { type: 'string', enum: ['normal', 'multiply', 'screen'], description: '混合方式,默认 normal' }
            },
            required: ['assetId', 'to']
          },
          recolor: {
            type: 'object',
            description: '调色/局部换色:整图或只在蒙版区域生效。氛围太亮/太冷/太饱和都可以先用它调,比重新生成便宜且不丢细节',
            properties: {
              maskAssetId: { type: 'string', description: '蒙版图 ID(用户涂抹的那张):透明处=要改的区域' },
              hue: { type: 'number', description: '色相偏移(度),如橘色→灰色可配 saturation=0' },
              saturation: { type: 'number', description: '饱和度倍率:1=不变,0=去色,1.3=更艳' },
              lightness: { type: 'number', description: '明度偏移:-0.15≈暗 15%,+0.1≈亮 10%' },
              contrast: { type: 'number', description: '对比度倍率:1=不变,1.2=更硬' },
              temperature: { type: 'number', description: '色温:-1 冷 … +1 暖,0=不变' },
              preserveLuma: { type: 'boolean', description: '换色时保持原亮度(只改色相/饱和),避免明暗跳变' }
            }
          },
          paint: {
            type: 'object',
            description:
              '确定性局部换色(不重绘,几何 100% 不变):把选中的像素刷成目标色,保留原明暗/纹理。用于"把键帽改成键盘主体的颜色""只把这块背景改成白"这类只改颜色、不能改形状的活 —— 比 edit_image 稳,因为它不做任何重绘。',
            properties: {
              target: { type: 'string', description: '目标色 #rrggbb;与 targetFrom 二选一' },
              targetFrom: {
                type: 'object',
                description: '从图里这个位置(0-1)取目标色,例如键盘主体;比手填色号更准',
                properties: { x: { type: 'number' }, y: { type: 'number' } }
              },
              color: { type: 'string', description: '只选接近这个颜色的像素(源图颜色),如白色键帽 #f2f0ea' },
              mode: { type: 'string', enum: ['albedo', 'shade'], description: '换色模式:albedo=反照率换色(默认,保留原图高光,像同一种塑料换了颜色);shade=按原明暗染色(旧行为,深色时容易像涂层)' },
              highlightProtect: { type: 'number', description: 'albedo 模式的高光保留强度 0-1,默认 0(哑光:边缘靠原光照自然变亮);亮面/金属再调到 0.3-0.8' },
              shadowLift: { type: 'number', description: 'albedo 模式的暗部提亮 0-1,默认 0;黑塑料暗部太死时加一点环境光' },
              tolerance: { type: 'number', description: '颜色容差 0-160,默认 42;漏选就调大,误选到主体就调小' },
              region: {
                type: 'object',
                description: '只在这块矩形内换色(0-1)',
                properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }
              },
              maskAssetId: { type: 'string', description: '用蒙版限定可换色区域(白色/不透明=可以改)' },
              maskGrow: { type: 'number', description: '蒙版向外扩张像素 0-16:蒙版只盖到键帽顶面、边缘留一圈亮边时,用它把键帽侧壁一起包进来' },
              exclude: {
                type: 'array',
                description: '排除区域列表(0-1),例如徽标所在位置:徽标不参与换色',
                items: {
                  type: 'object',
                  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }
                }
              },
              preserveShading: { type: 'boolean', description: '保留原明暗/纹理,默认 true;传 false = 刷成纯色' },
              strength: { type: 'number', description: '强度 0-1,默认 1' },
              featherPx: { type: 'number', description: '选区边缘羽化像素,默认 2' }
            }
          },
          corners: {
            type: 'object',
            description: '圆角 + 可选描边/底色',
            properties: {
              radius: { type: 'number', description: '圆角半径,占短边的比例 0-0.5' },
              stroke: { type: 'number', description: '描边宽度(像素),可选' },
              strokeColor: { type: 'string', description: '描边颜色,如 #2a2a2a' },
              background: { type: 'string', description: '圆角外的底色,如 #ffffff;省略=透明' }
            },
            required: ['radius']
          },
          canvas: {
            type: 'object',
            description: '改画布尺寸(居中放置原图,其余填底色)',
            properties: {
              width: { type: 'number', description: '目标宽(像素),可选' },
              height: { type: 'number', description: '目标高(像素),可选' },
              fill: { type: 'string', description: '填充色,如 #ffffff;省略=透明' }
            }
          },
          collage: {
            type: 'object',
            description: '拼接:把多张图排成网格(替代手工拼图)',
            properties: {
              assetIds: { type: 'array', items: { type: 'string' }, description: '要拼接的图片 ID 列表(2-9 张,第一张通常是底图)' },
              cols: { type: 'number', description: '列数,默认按张数取平方根' },
              gap: { type: 'number', description: '格子间距(像素)' },
              margin: { type: 'number', description: '外边距(像素)' },
              background: { type: 'string', description: '底色,默认 #ffffff' }
            },
            required: ['assetIds']
          }
        },
        required: ['assetId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'compare_image',
      description:
        '本地比对(¥0):把当前图和基线(默认=版本链根/用户最初上传的原图)逐像素对比,回答"该改的改了没有、不该改的动没动"。返回:允许区域外的改动比例与聚集位置、区域内改动比例、边界锚定率(重绘/位移检测)。可选输出差异热图(红=区域内改动,黄=区域外不该有的改动)。修改后、交付前应当调用它自检。',
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string', description: '当前图资产 ID' },
          baselineAssetId: { type: 'string', description: '基线图 ID;省略 = 沿版本链找根(用户最初上传的那张)' },
          region: {
            type: 'object',
            description: '本次"允许改动"的矩形(0-1);不给 = 整图都算允许(只能看总改动)',
            properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }
          },
          maskAssetId: { type: 'string', description: '允许改动的蒙版(白色/不透明=可以改)' },
          heatmap: { type: 'boolean', description: '同时输出差异热图(标注图,不进版本树),默认 false' }
        },
        required: ['assetId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'inspect_grid',
      description:
        '给一张图叠加 10×10 坐标网格(0-1 比例)后作为新图返回,让你能读出精确位置再调用 composite_image(贴图/裁剪)。网格线本身就是刻度:每格 0.1,从左/上数格子即可。',
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string', description: '要标注的图片 ID' },
          cells: { type: 'number', description: '网格数,默认 10(=每格 0.1)' }
        },
        required: ['assetId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'process_image',
      description:
        '本地处理图片(不调用生图服务):格式转换(png/jpeg)、压缩(quality 1-100,jpeg)、缩放(按百分比或最大边)。产物作为新图片进入会话。',
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string', description: '要处理的图片 ID(asset-xxx)' },
          format: { type: 'string', enum: ['png', 'jpeg'], description: '输出格式,默认 png' },
          quality: { type: 'number', description: 'jpeg 质量 1-100,默认 85;仅 jpeg 有效' },
          scalePercent: { type: 'number', description: '缩放百分比(如 50 表示缩小一半),可选' },
          maxWidth: { type: 'number', description: '最大宽度像素(等比缩放),可选' },
          maxHeight: { type: 'number', description: '最大高度像素(等比缩放),可选' }
        },
        required: ['assetId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: '移动文件到目标文件夹(重命名合并为移动)。用于整理素材、归类产出。同名文件自动加序号,不会覆盖。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '源文件绝对路径' },
          destDir: { type: 'string', description: '目标文件夹(不存在会创建)' }
        },
        required: ['path', 'destDir']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'copy_file',
      description: '复制文件到目标文件夹(保留原文件)。同名文件自动加序号,不会覆盖。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '源文件绝对路径' },
          destDir: { type: 'string', description: '目标文件夹(不存在会创建)' }
        },
        required: ['path', 'destDir']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        '向用户提问并在界面问答面板等待作答(选择题优先)。凡需要用户决策的场合——需求确认、微调方案选择、风格取舍——都必须用它,不要用纯文本提问。选项 2-4 个,必须恰好一个 recommended=true(推荐答案);开放性描述(如"描述你想要的氛围")才用纯文本提问。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '问题文本,一句话,具体可答' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: '选项文案(简短)' },
                description: { type: 'string', description: '选项说明(可选,一句话)' },
                recommended: { type: 'boolean', description: '是否为推荐答案;必须恰好一个选项为 true' }
              },
              required: ['label']
            },
            description: '选项列表(2-4 个,恰好一个推荐)'
          }
        },
        required: ['question', 'options']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description:
        '列出本机某个文件夹的内容(文件与子目录,含大小与修改时间)。用于浏览用户素材库、查找参考图片等。支持 ~ 表示用户目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件夹绝对路径,如 D:\\素材库 或 ~/Pictures' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取本机文本文件内容(如提示词文档、素材说明 txt/md/json 等),过长自动截断。图片文件请改用 import_image。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'import_image',
      description:
        '把本机的一张图片文件导入会话资产(之后你能看到图片内容,用户会在界面看到,且可用于 edit_image 编辑)。浏览素材库找到合适素材后用它导入。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '图片文件绝对路径(png/jpg/jpeg/webp/gif)' }
        },
        required: ['path']
      }
    }
  }
]

export interface ToolCtx {
  sessionId: string
  signal: AbortSignal
  emit: (ev: AgentEvent) => void
}

export interface ToolResult {
  ok: boolean
  text: string
  assetIds: string[]
}

// ---------- update_brief ----------

function briefSummary(brief: ImageBrief): string {
  const filled = BRIEF_SLOTS.filter((s) => {
    const v = brief[s.key]
    return typeof v === 'string' && v.trim()
  }).map((s) => `${s.label}=${String(brief[s.key]).trim()}`)
  return filled.length ? filled.join('; ') : '(空)'
}

export function execUpdateBrief(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const db = getDb()
  const { confirmed, ...slots } = args
  const markConfirmed = confirmed === true
  const brief = db.patchBrief(ctx.sessionId, slots as ImageBrief, markConfirmed)
  ctx.emit({ type: 'brief-updated', sessionId: ctx.sessionId, brief })
  if (markConfirmed && brief.confirmedAt) {
    return { ok: true, text: `需求已记录并标记为已确认。当前规格:${briefSummary(brief)}。现在可以调用 generate_image 执行生成。`, assetIds: [] }
  }
  return {
    ok: true,
    text: `需求已记录。当前规格:${briefSummary(brief)}。确认状态:未确认 —— 请向用户复述完整需求摘要并请求确认。`,
    assetIds: []
  }
}

// ---------- generate_image ----------

export async function execGenerateImage(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) return { ok: false, text: '参数错误:prompt 不能为空', assetIds: [] }

  const profile = getSettings().activeImageProfile()
  if (!profile) {
    return { ok: false, text: '当前未配置生图服务。请告知用户:点击设置添加图片服务(OpenAI 兼容 /images 接口)后重试。', assetIds: [] }
  }

  const db = getDb()
  const brief = db.brief(ctx.sessionId)
  const ratio = (args.aspectRatio ? String(args.aspectRatio) : brief.aspectRatio) || undefined
  // 分辨率:显式 size 优先,其次需求规格 resolution,最后按比例映射
  const size = parseExplicitSize(String(args.size ?? '')) ?? parseExplicitSize(brief.resolution ?? '')
  if (args.size && !parseExplicitSize(String(args.size))) {
    return { ok: false, text: `参数错误:size 格式应为 WxH(如 2048x2048),收到 "${String(args.size)}"。`, assetIds: [] }
  }
  // 部分服务单次仅支持 1 张(如 gpt-image-2),按配置上限钳制
  const maxN = profile.maxN && profile.maxN > 0 ? profile.maxN : 4
  const n = Math.min(maxN, Math.max(1, Number(args.n ?? 1) || 1))
  // 候选数量:一次出多张供用户挑选;端点只支持单张时串行补足
  const rawVariants = Number(args.variants ?? 1)
  const variants = Number.isFinite(rawVariants) ? Math.min(4, Math.max(1, Math.trunc(rawVariants))) : 1
  // 画质档位:auto = 跟随模型配置
  const qualityArg = String(args.quality ?? '').trim()
  const quality = qualityArg && qualityArg !== 'auto' ? qualityArg : undefined
  const maxRefs = profile.maxReferenceImages ?? 16
  const maxPrompt = profile.maxPromptChars ?? 32_000

  // 把「规避元素」编译成模型可执行的约束句(此前只显示在面板里,模型并不知道),长度一并校验
  const finalPrompt = prompt + buildConstraintClause(brief, prompt)
  if (finalPrompt.length > maxPrompt) {
    return { ok: false, text: `提示词过长(${finalPrompt.length} 字符,上限 ${maxPrompt}),请精简后重试。`, assetIds: [] }
  }

  // 参考图融合:带参考图时走 edits 端点(多图输入)
  const referenceIds = Array.isArray(args.referenceAssetIds)
    ? (args.referenceAssetIds as unknown[]).map(String).filter(Boolean).slice(0, maxRefs)
    : []
  const references = referenceIds.map((id) => db.asset(id)).filter((a): a is ImageAsset => a !== undefined && a.kind !== 'mask')
  const oversized = references.find((a) => readAssetBuffer(a).length > (profile.maxImageMB ?? 25) * 1024 * 1024)
  if (oversized) {
    return { ok: false, text: `参考图 ${oversized.id} 超过单图上限 ${profile.maxImageMB ?? 25}MB,请先缩小或换图。`, assetIds: [] }
  }

  const total = variants > 1 ? variants : n
  const isDraft = total > 1
  const batchId = isDraft ? `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` : undefined
  const timeoutMs = getSettings().load().imageTimeoutMs

  const runOnce = async (count: number): Promise<GeneratedImages> =>
    references.length > 0
      ? editImage({
          profile,
          prompt: finalPrompt,
          images: references.map((a) => ({ buffer: readAssetBuffer(a), mime: a.mime })),
          ratio,
          size: size ?? undefined,
          quality,
          timeoutMs,
          signal: ctx.signal
        })
      : generateImages({
          profile,
          prompt: finalPrompt,
          ratio,
          size: size ?? undefined,
          n: count,
          quality,
          timeoutMs,
          signal: ctx.signal
        })

  const startedAt = Date.now()
  const results: GeneratedImages[] = []
  if (references.length === 0 && maxN >= total) {
    // 端点支持一次多张:一次调用出全部候选,少一轮等待
    results.push(await runOnce(total))
  } else {
    // 端点只支持单张或带参考图:串行补足;用户取消立即停止
    for (let i = 0; i < total; i++) {
      if (ctx.signal?.aborted) break
      // eslint-disable-next-line no-await-in-loop
      results.push(await runOnce(1))
    }
  }

  const buffers = results.flatMap((r) => r.buffers)
  if (!buffers.length) {
    return { ok: false, text: '生成被取消,或接口未返回任何图片。', assetIds: [] }
  }
  const elapsedMs = Date.now() - startedAt

  const assetIds: string[] = []
  for (const buffer of buffers) {
    const asset = saveBufferAsset({
      sessionId: ctx.sessionId,
      buffer,
      mime: guessMime(buffer),
      kind: 'generated',
      prompt: finalPrompt,
      draft: isDraft || undefined,
      batchId,
      meta: {
        model: profile.model,
        provider: profile.name,
        size: size ?? results[0]?.requestedSize,
        actualSize: results[0]?.actualSize,
        ratio,
        quality,
        referenceAssetIds: references.length ? references.map((a) => a.id) : undefined,
        variants: isDraft ? total : undefined,
        dropped: results.flatMap((r) => r.dropped).length ? Array.from(new Set(results.flatMap((r) => r.dropped))) : undefined,
        elapsedMs,
        // 每个资产对应一张图,单价即该图成本(批量总价 = 各资产之和)
        cost: computeCost(undefined, profile.pricePerImage, 1)
      }
    })
    assetIds.push(asset.id)
    ctx.emit({ type: 'asset-added', sessionId: ctx.sessionId, asset })
  }

  const dropped = Array.from(new Set(results.flatMap((r) => r.dropped)))
  const requestedSize = results[0]?.requestedSize
  const clampedFrom = results[0]?.clampedFrom
  const actualSize = results[0]?.actualSize
  const parts: string[] = [
    isDraft ? `已生成 ${assetIds.length} 张候选图:${assetIds.join(', ')}(同批次)` : `已生成图片:${assetIds.join(', ')}`
  ]
  if (references.length > 0) parts.push(`已融合 ${references.length} 张参考图`)
  if (requestedSize || actualSize) {
    parts.push(
      requestedSize && actualSize && requestedSize !== actualSize
        ? `请求 ${requestedSize},实际返回 ${actualSize}`
        : `尺寸 ${actualSize ?? requestedSize}`
    )
  }
  // 超过端点长边上限时本地已按比例收敛:必须说清楚,否则用户以为拿到的是原分辨率
  if (clampedFrom && requestedSize) parts.push(`原请求 ${clampedFrom} 不符合端点尺寸约束(长边 ≤3840、宽高为 16 的倍数、至少 1MP),已收敛为 ${requestedSize}(请如实告知用户)`)
  const dropNote = describeDropped(dropped)
  if (dropNote) parts.push(`${dropNote}(画质可能受影响,请如实告知用户)`)
  if (isDraft) {
    parts.push('候选图尚未进入版本链:请用 ask_user 让用户挑选(2-4 个选项,推荐项按你的专业判断),选定后以该图为源继续')
  }
  parts.push('请向用户简短说明结果与下一步建议')
  return { ok: true, text: `${parts.join(';')}。`, assetIds }
}

// ---------- edit_image ----------

export async function execEditImage(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const db = getDb()
  const instruction = String(args.instruction ?? '').trim()
  const maskAssetId = args.maskAssetId ? String(args.maskAssetId) : undefined
  if (!instruction) return { ok: false, text: '参数错误:assetIds 与 instruction 必填', assetIds: [] }

  // 保真护栏参数先校验:不依赖是否已配置生图服务
  const protectRaw = args.protect && typeof args.protect === 'object' ? (args.protect as Record<string, unknown>) : null
  const protectRegion = protectRaw ? guardRectOf(protectRaw.region) : undefined
  const protectMaskId = protectRaw?.maskAssetId ? String(protectRaw.maskAssetId) : ''
  const protectAuto = protectRaw?.auto === true
  if (protectRaw && !protectRegion && !protectMaskId && !protectAuto) {
    return {
      ok: false,
      text: 'protect 需要 region、maskAssetId 或 auto:true 之一,否则等于整图都允许改、起不到保护作用。不知道坐标时传 auto:true(只保留成片的改动);想精确保护某块(徽标/屏幕/文字)用 region 或 maskAssetId。',
      assetIds: []
    }
  }
  if (protectRaw) {
    const rawIds = (Array.isArray(args.assetIds) ? (args.assetIds as unknown[]) : args.assetId ? [args.assetId] : []).filter(Boolean)
    if (rawIds.length > 1) {
      return { ok: false, text: 'protect 仅支持单源图;多图融合没有"原图"可保护,请去掉 protect。', assetIds: [] }
    }
  }

  const profile = getSettings().activeImageProfile()
  if (!profile) {
    return { ok: false, text: '当前未配置生图服务。请告知用户:在设置中添加图片服务(需支持 /images/edits)后重试。', assetIds: [] }
  }
  const maxRefs = profile.maxReferenceImages ?? 16
  // 编辑同样带上「规避元素」约束;用户已明确要求边框类元素时护栏会自动让路
  const editBrief = db.brief(ctx.sessionId)
  const finalInstruction = instruction + buildConstraintClause(editBrief, instruction)
  if (finalInstruction.length > (profile.maxPromptChars ?? 32_000)) {
    return { ok: false, text: `编辑指令过长(上限 ${profile.maxPromptChars ?? 32000} 字符),请精简后重试。`, assetIds: [] }
  }

  const ids = (Array.isArray(args.assetIds) ? (args.assetIds as unknown[]).map(String) : args.assetId ? [String(args.assetId)] : [])
    .filter(Boolean)
    .slice(0, maxRefs)

  const sources = ids.map((id) => db.asset(id)).filter((a): a is ImageAsset => a !== undefined && a.kind !== 'mask')
  if (sources.length === 0) {
    return { ok: false, text: `未找到可编辑的图片,请使用上下文中标注的资产 ID。`, assetIds: [] }
  }
  const oversized = sources.find((a) => readAssetBuffer(a).length > (profile.maxImageMB ?? 25) * 1024 * 1024)
  if (oversized) {
    return { ok: false, text: `源图 ${oversized.id} 超过单图上限 ${profile.maxImageMB ?? 25}MB,请先缩小或换图。`, assetIds: [] }
  }

  let mask: Buffer | undefined
  if (maskAssetId) {
    if (sources.length > 1) {
      return { ok: false, text: '蒙版仅支持单张源图;多图融合请去掉 maskAssetId,在 instruction 中描述各图元素的位置安排。', assetIds: [] }
    }
    const maskAsset = db.asset(maskAssetId)
    if (!maskAsset) return { ok: false, text: `蒙版图片 ${maskAssetId} 不存在。`, assetIds: [] }
    mask = readAssetBuffer(maskAsset)
  }

  const qualityArg = String(args.quality ?? '').trim()
  const editStartedAt = Date.now()
  // 尺寸:显式传了就用;没传就沿用源图尺寸(扩图/保持构图时不能落回接口默认 1024)
  const sourceSize = sources[0].width && sources[0].height ? `${sources[0].width}x${sources[0].height}` : undefined
  const editSize = parseExplicitSize(String(args.size ?? '')) ?? sourceSize
  const result = await editImage({
    profile,
    prompt: finalInstruction,
    images: sources.map((a) => ({ buffer: readAssetBuffer(a), mime: a.mime })),
    mask,
    ratio: args.aspectRatio ? String(args.aspectRatio) : undefined,
    size: editSize,
    quality: qualityArg && qualityArg !== 'auto' ? qualityArg : undefined,
    timeoutMs: getSettings().load().imageTimeoutMs,
    signal: ctx.signal
  })

  const primary = sources[0]

  let baselineAsset: ImageAsset | undefined
  let baselineImage: RgbaImage | undefined
  let protectMaskImage: RgbaImage | undefined
  if (protectRaw) {
    if (sources.length > 1) {
      return { ok: false, text: 'protect 仅支持单源图;多图融合没有"原图"可保护,请去掉 protect。', assetIds: [] }
    }
    const baselineId = protectRaw.baselineAssetId ? String(protectRaw.baselineAssetId) : originOf(primary.id)
    baselineAsset = db.asset(baselineId)
    if (!baselineAsset) return { ok: false, text: `基线图 ${baselineId} 不存在。`, assetIds: [] }
    const baselineLoaded = loadRgbaAsset(baselineId)
    if (!baselineLoaded.image) return { ok: false, text: baselineLoaded.error ?? '基线图解码失败', assetIds: [] }
    baselineImage = baselineLoaded.image
    if (protectMaskId) {
      const maskLoaded = loadRgbaAsset(protectMaskId)
      if (!maskLoaded.image) return { ok: false, text: maskLoaded.error ?? '保护蒙版解码失败', assetIds: [] }
      protectMaskImage = maskLoaded.image
    }
  }

  const assetIds: string[] = []
  const guardReports: EditGuardReport[] = []
  for (const rawBuffer of result.buffers) {
    let buffer = rawBuffer
    let guardReport: EditGuardReport | undefined
    if (protectRaw && baselineImage) {
      const editedImage = decodeRgba(rawBuffer)
      if (!editedImage) return { ok: false, text: '模型返回图无法本地解码,保真合成失败;请重试或去掉 protect。', assetIds }
      const guarded = applyEditGuard(baselineImage, editedImage, {
        ...(protectRegion ? { region: protectRegion } : {}),
        ...(protectMaskImage ? { mask: protectMaskImage, maskKind: 'user' as const } : {}),
        ...(protectAuto && !protectRegion && !protectMaskImage ? { auto: true } : {}),
        featherPx: protectRaw.featherPx === undefined ? 3 : Math.max(0, readNum(protectRaw.featherPx)),
        ...(protectRaw.minAnchor === undefined ? {} : { minAnchor: readNum(protectRaw.minAnchor, 0.72) }),
        ...(baselineAsset ? { baselineAssetId: baselineAsset.id } : {})
      })
      buffer = encodeRgba(guarded.image, 'png')
      guardReport = guarded.report
      guardReports.push(guardReport)
    }
    const asset: ImageAsset = saveBufferAsset({
      sessionId: ctx.sessionId,
      buffer,
      mime: guardReport ? 'image/png' : guessMime(buffer),
      kind: 'edited',
      parentId: primary.id,
      prompt: finalInstruction,
      meta: {
        model: profile.model,
        provider: profile.name,
        size: args.size ? parseExplicitSize(String(args.size)) ?? undefined : undefined,
        actualSize: guardReport && baselineImage ? `${baselineImage.width}x${baselineImage.height}` : result.actualSize,
        ratio: args.aspectRatio ? String(args.aspectRatio) : undefined,
        quality: qualityArg && qualityArg !== 'auto' ? qualityArg : undefined,
        editedFrom: sources.map((s) => s.id),
        masked: Boolean(mask),
        maskAssetId,
        dropped: result.dropped.length ? result.dropped : undefined,
        elapsedMs: Date.now() - editStartedAt,
        cost: computeCost(undefined, profile.pricePerImage, 1),
        originAssetId: baselineAsset?.id ?? originOf(primary.id),
        ...(guardReport ? { guard: guardReport } : {})
      }
    })
    assetIds.push(asset.id)
    ctx.emit({ type: 'asset-added', sessionId: ctx.sessionId, asset })
  }
  const srcNote = sources.length > 1 ? `融合 ${sources.length} 张源图(${sources.map((s) => s.id).join(' + ')})` : `基于 ${primary.id}`
  const sizeNote = result.actualSize ? `;实际 ${result.actualSize}` : ''
  const clampNote = result.clampedFrom ? `;原请求 ${result.clampedFrom} 不符合端点尺寸约束(长边 ≤3840、宽高为 16 的倍数、至少 1MP),已收敛为 ${result.requestedSize}(请如实告知用户)` : ''
  const dropNote = describeDropped(result.dropped)
  const degradeNote = dropNote ? `;${dropNote}` : ''
  const guardNote = guardReports.length
    ? `保真合成(基线 ${baselineAsset?.id}):` +
      guardReports
        .map((r) => `${guardSummary(r)}${r.autoGuard ? `;自动护栏:留 ${r.autoGuard.kept}/${r.autoGuard.islands} 片(占 ${(r.autoGuard.keptCoverage * 100).toFixed(1)}%),还原零散噪点 ${(r.autoGuard.revertedShare * 100).toFixed(1)}%` : ''}${r.verdict === 'suspect' ? `;⚠ ${r.note}。建议缩小 protect 区域重试,或改用 composite_image 的 paint 做纯换色` : ''}`)
        .join(' / ')
    : ''
  return {
    ok: true,
    text: `已完成编辑,${srcNote} 生成 ${assetIds.length} 张新图:${assetIds.join(', ')}${sizeNote}${clampNote}${degradeNote}。${guardNote ? guardNote + '。' : ''}请向用户展示结果。`,
    assetIds
  }
}

// ---------- 文件系统工具 ----------

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/png'
}
const MAX_READ_CHARS = 8000
const MAX_DIR_ENTRIES = 300

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export function execListDirectory(_ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const raw = String(args.path ?? '').trim()
  if (!raw) return { ok: false, text: '参数错误:path 不能为空', assetIds: [] }
  const dir = path.resolve(expandHome(raw))
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return { ok: false, text: `无法读取目录 ${dir}:${err instanceof Error ? err.message : String(err)}`, assetIds: [] }
  }
  const lines: string[] = [`目录 ${dir} 共 ${entries.length} 项:`]
  // 目录在前,名称排序
  const sorted = [...entries].sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
  const shown = sorted.slice(0, MAX_DIR_ENTRIES)
  for (const e of shown) {
    if (e.isDirectory()) {
      lines.push(`[目录] ${e.name}/`)
    } else {
      try {
        const st = fs.statSync(path.join(dir, e.name))
        lines.push(`[文件] ${e.name} (${fmtSize(st.size)}, ${new Date(st.mtimeMs).toLocaleDateString('zh-CN')})`)
      } catch {
        lines.push(`[文件] ${e.name}`)
      }
    }
  }
  if (sorted.length > shown.length) lines.push(`… 其余 ${sorted.length - shown.length} 项未显示,可进入子目录查看`)
  return { ok: true, text: lines.join('\n').slice(0, 12000), assetIds: [] }
}

export function execReadFile(_ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const raw = String(args.path ?? '').trim()
  if (!raw) return { ok: false, text: '参数错误:path 不能为空', assetIds: [] }
  const file = path.resolve(expandHome(raw))
  let buffer: Buffer
  try {
    buffer = fs.readFileSync(file)
  } catch (err) {
    return { ok: false, text: `无法读取文件 ${file}:${err instanceof Error ? err.message : String(err)}`, assetIds: [] }
  }
  if (IMAGE_EXTS.has(path.extname(file).toLowerCase())) {
    return { ok: false, text: '这是图片文件,请改用 import_image 导入后直接查看。', assetIds: [] }
  }
  if (buffer.length > 2 * 1024 * 1024) {
    return { ok: false, text: `文件过大(${fmtSize(buffer.length)}),请指定更小的文本文件。`, assetIds: [] }
  }
  const text = buffer.toString('utf8')
  if (text.includes('\u0000')) {
    return { ok: false, text: '这是二进制文件,无法按文本读取。', assetIds: [] }
  }
  const truncated = text.length > MAX_READ_CHARS
  return { ok: true, text: `${file}\n\n${text.slice(0, MAX_READ_CHARS)}${truncated ? `\n…(已截断,原文 ${text.length} 字符)` : ''}`, assetIds: [] }
}

export function execImportImage(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const raw = String(args.path ?? '').trim()
  if (!raw) return { ok: false, text: '参数错误:path 不能为空', assetIds: [] }
  const file = path.resolve(expandHome(raw))
  const ext = path.extname(file).toLowerCase()
  if (!IMAGE_EXTS.has(ext)) {
    return { ok: false, text: `不支持的图片格式:${ext || '(无扩展名)'}。支持 png/jpg/jpeg/webp/gif/bmp。`, assetIds: [] }
  }
  // 单图上限跟随当前生图服务配置(默认 25MB,与参考图一致)
  const imageProfile = getSettings().activeImageProfile()
  const maxBytes = (imageProfile?.maxImageMB ?? 25) * 1024 * 1024
  let buffer: Buffer
  try {
    const st = fs.statSync(file)
    if (st.size > maxBytes) return { ok: false, text: `图片过大(${fmtSize(st.size)},上限 ${imageProfile?.maxImageMB ?? 25}MB)。`, assetIds: [] }
    buffer = fs.readFileSync(file)
  } catch (err) {
    return { ok: false, text: `无法读取图片 ${file}:${err instanceof Error ? err.message : String(err)}`, assetIds: [] }
  }
  const asset = saveBufferAsset({
    sessionId: ctx.sessionId,
    buffer,
    mime: MIME_BY_EXT[ext] ?? 'image/png',
    kind: 'user-upload',
    prompt: `导入自 ${file}`
  })
  ctx.emit({ type: 'asset-added', sessionId: ctx.sessionId, asset })
  return { ok: true, text: `已导入图片 ${asset.id}(${path.basename(file)},${fmtSize(buffer.length)})。图片内容已附在后续上下文中,可直接查看。`, assetIds: [asset.id] }
}

const MAX_WRITE_CHARS = 200_000

export function execWriteFile(_ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const raw = String(args.path ?? '').trim()
  const content = String(args.content ?? '')
  if (!raw) return { ok: false, text: '参数错误:path 不能为空', assetIds: [] }
  if (content.length > MAX_WRITE_CHARS) {
    return { ok: false, text: `内容过长(${content.length} 字符,上限 ${MAX_WRITE_CHARS}),请分次写入。`, assetIds: [] }
  }
  const file = path.resolve(expandHome(raw))
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const existed = fs.existsSync(file)
    fs.writeFileSync(file, content, 'utf8')
    return { ok: true, text: `${existed ? '已覆盖' : '已创建'} ${file}(${content.length} 字符)。`, assetIds: [] }
  } catch (err) {
    return { ok: false, text: `写入失败 ${file}:${err instanceof Error ? err.message : String(err)}`, assetIds: [] }
  }
}

export function execEditFile(_ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const raw = String(args.path ?? '').trim()
  const oldText = String(args.oldText ?? '')
  const newText = String(args.newText ?? '')
  if (!raw || !oldText) return { ok: false, text: '参数错误:path 与 oldText 必填(oldText 不能为空)', assetIds: [] }
  const file = path.resolve(expandHome(raw))
  let content: string
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, text: `无法读取文件 ${file}:${err instanceof Error ? err.message : String(err)}`, assetIds: [] }
  }
  const count = content.split(oldText).length - 1
  if (count === 0) {
    return { ok: false, text: `未在 ${file} 中找到要替换的文本。请先用 read_file 核对原文(注意空格与换行)。`, assetIds: [] }
  }
  try {
    fs.writeFileSync(file, content.split(oldText).join(newText), 'utf8')
    const note = count > 1 ? `(共替换 ${count} 处)` : ''
    return { ok: true, text: `已编辑 ${file}:替换完成${note}。`, assetIds: [] }
  } catch (err) {
    return { ok: false, text: `写入失败 ${file}:${err instanceof Error ? err.message : String(err)}`, assetIds: [] }
  }
}

// ---------- 图片本地处理与文件整理 ----------

function uniqueDest(destDir: string, name: string): string {
  let target = path.join(destDir, name)
  if (!fs.existsSync(target)) return target
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  for (let i = 2; i < 1000; i++) {
    target = path.join(destDir, `${base} (${i})${ext}`)
    if (!fs.existsSync(target)) return target
  }
  throw new Error('目标目录同名文件过多')
}

export function execMoveFile(_ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const src = path.resolve(expandHome(String(args.path ?? '').trim()))
  const destDir = path.resolve(expandHome(String(args.destDir ?? '').trim()))
  if (!src || !destDir) return { ok: false, text: '参数错误:path 与 destDir 必填', assetIds: [] }
  try {
    if (!fs.existsSync(src)) return { ok: false, text: `源文件不存在:${src}`, assetIds: [] }
    fs.mkdirSync(destDir, { recursive: true })
    const target = uniqueDest(destDir, path.basename(src))
    try {
      fs.renameSync(src, target)
    } catch {
      // 跨盘移动:复制后删除
      fs.copyFileSync(src, target)
      fs.unlinkSync(src)
    }
    return { ok: true, text: `已移动:${src} → ${target}`, assetIds: [] }
  } catch (err) {
    return { ok: false, text: `移动失败:${err instanceof Error ? err.message : String(err)}`, assetIds: [] }
  }
}

export function execCopyFile(_ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const src = path.resolve(expandHome(String(args.path ?? '').trim()))
  const destDir = path.resolve(expandHome(String(args.destDir ?? '').trim()))
  if (!src || !destDir) return { ok: false, text: '参数错误:path 与 destDir 必填', assetIds: [] }
  try {
    if (!fs.existsSync(src)) return { ok: false, text: `源文件不存在:${src}`, assetIds: [] }
    fs.mkdirSync(destDir, { recursive: true })
    const target = uniqueDest(destDir, path.basename(src))
    fs.copyFileSync(src, target)
    return { ok: true, text: `已复制:${src} → ${target}`, assetIds: [] }
  } catch (err) {
    return { ok: false, text: `复制失败:${err instanceof Error ? err.message : String(err)}`, assetIds: [] }
  }
}

export function execProcessImage(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const assetId = String(args.assetId ?? '')
  const format = String(args.format ?? 'png').toLowerCase() as 'png' | 'jpeg'
  const quality = Math.min(100, Math.max(1, Number(args.quality ?? 85) || 85))
  if (!assetId) return { ok: false, text: '参数错误:assetId 必填', assetIds: [] }
  if (format !== 'png' && format !== 'jpeg') {
    return { ok: false, text: '本地处理仅支持 png / jpeg 输出(webp 等请换用生图服务)。', assetIds: [] }
  }
  const db = getDb()
  const asset = db.asset(assetId)
  if (!asset || asset.kind === 'mask') return { ok: false, text: `图片 ${assetId} 不存在或不可处理。`, assetIds: [] }

  let img = nativeImage.createFromBuffer(readAssetBuffer(asset))
  if (img.isEmpty()) {
    return { ok: false, text: '该图片格式无法本地解码(支持 png/jpg),请改用生图服务处理。', assetIds: [] }
  }
  const before = img.getSize()
  const scalePercent = Number(args.scalePercent)
  const maxWidth = Number(args.maxWidth)
  const maxHeight = Number(args.maxHeight)
  let targetW = before.width
  let targetH = before.height
  if (scalePercent > 0 && scalePercent !== 100) {
    targetW = Math.max(1, Math.round((before.width * scalePercent) / 100))
    targetH = Math.max(1, Math.round((before.height * scalePercent) / 100))
  }
  if (maxWidth > 0 && targetW > maxWidth) {
    targetH = Math.max(1, Math.round((targetH * maxWidth) / targetW))
    targetW = maxWidth
  }
  if (maxHeight > 0 && targetH > maxHeight) {
    targetW = Math.max(1, Math.round((targetW * maxHeight) / targetH))
    targetH = maxHeight
  }
  if (targetW !== before.width || targetH !== before.height) {
    img = img.resize({ width: targetW, height: targetH, quality: 'good' })
  }
  const buffer = format === 'jpeg' ? img.toJPEG(quality) : img.toPNG()
  const ops: string[] = []
  if (targetW !== before.width || targetH !== before.height) ops.push(`缩放 ${before.width}×${before.height}→${targetW}×${targetH}`)
  ops.push(`转 ${format}${format === 'jpeg' ? ` q${quality}` : ''}`)
  const newAsset = saveBufferAsset({
    sessionId: ctx.sessionId,
    buffer,
    mime: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    kind: 'edited',
    parentId: asset.id,
    prompt: `本地处理:${ops.join(', ')}`
  })
  ctx.emit({ type: 'asset-added', sessionId: ctx.sessionId, asset: newAsset })
  return {
    ok: true,
    text: `已处理 ${asset.id}:${ops.join(',')};新图 ${newAsset.id}(${fmtSize(buffer.length)})。`,
    assetIds: [newAsset.id]
  }
}

// ---------- 本地合成(¥0,像素级) ----------

interface NormRect {
  x: number
  y: number
  w: number
  h: number
}

function readNum(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function readNormRect(value: unknown): NormRect | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const rect = { x: readNum(o.x), y: readNum(o.y), w: readNum(o.w), h: readNum(o.h) }
  if (rect.w <= 0 || rect.h <= 0) return null
  return rect
}

/** 读资产并解码成直通 alpha 的 RGBA;失败返回原因 */
function loadRgbaAsset(assetId: string): { image?: RgbaImage; error?: string } {
  const asset = getDb().asset(assetId)
  if (!asset) return { error: `图片 ${assetId} 不存在` }
  const image = decodeRgba(readAssetBuffer(asset))
  if (!image) return { error: `图片 ${assetId} 无法本地解码(支持 png/jpg)` }
  return { image }
}

/** 沿版本链找到根:用户最初上传/生成的那张,后续修改都以它为比对基线 */
function originOf(assetId: string): string {
  const db = getDb()
  let cur = db.asset(assetId)
  const seen = new Set<string>()
  while (cur?.parentId && !seen.has(cur.id)) {
    seen.add(cur.id)
    const parent = db.asset(cur.parentId)
    if (!parent) break
    cur = parent
  }
  return cur?.id ?? assetId
}

function guardRectOf(value: unknown): GuardRect | undefined {
  const rect = readNormRect(value)
  return rect ?? undefined
}

function roundRectText(rect: NormRect): string {
  const f = (n: number): string => (Math.abs(n) < 0.0005 ? '0' : n.toFixed(3))
  return `(${f(rect.x)}, ${f(rect.y)}, ${f(rect.w)}, ${f(rect.h)})`
}

function hexOf(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}

export function execCompositeImage(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const assetId = String(args.assetId ?? '').trim()
  if (!assetId) return { ok: false, text: '参数错误:assetId 必填', assetIds: [] }
  const db = getDb()
  const base = db.asset(assetId)
  if (!base) return { ok: false, text: `底图 ${assetId} 不存在。`, assetIds: [] }
  if (base.kind === 'mask') return { ok: false, text: '蒙版不能当底图合成;请在 recolor.maskAssetId 里用它。', assetIds: [] }

  const loaded = loadRgbaAsset(assetId)
  if (!loaded.image) return { ok: false, text: loaded.error ?? '底图解码失败', assetIds: [] }
  const guarded = guardSize(loaded.image)
  let image = guarded.image
  const ops: string[] = []
  const sources: string[] = []
  if (guarded.scaled) ops.push(`底图过大,已等比缩到 ${image.width}×${image.height}`)

  // ① 拼接(定义底板)
  const collageRaw = args.collage as Record<string, unknown> | undefined
  if (collageRaw && Array.isArray(collageRaw.assetIds) && collageRaw.assetIds.length) {
    const ids = [...new Set([...collageRaw.assetIds.map((v) => String(v)), ...(collageRaw.assetIds.some((v) => String(v) === assetId) ? [] : [assetId])])]
    if (ids.length < 2) return { ok: false, text: '拼接至少需要 2 张图(assetIds 里补一张)。', assetIds: [] }
    const pieces: RgbaImage[] = []
    for (const id of ids) {
      const item = loadRgbaAsset(id)
      if (!item.image) return { ok: false, text: item.error ?? `${id} 解码失败`, assetIds: [] }
      pieces.push(guardSize(item.image).image)
      sources.push(id)
    }
    const background = parseColor(collageRaw.background) ?? [255, 255, 255, 255]
    image = gridImages(
      pieces,
      {
        cols: readNum(collageRaw.cols) || undefined,
        gap: readNum(collageRaw.gap) || undefined,
        margin: readNum(collageRaw.margin) || undefined,
        background
      }
    )
    ops.push(`拼接 ${ids.length} 张 → ${image.width}×${image.height}`)
  }

  // ② 裁剪
  const crop = readNormRect(args.crop)
  if (crop) {
    image = cropImage(image, normRectToPixels(crop, image.width, image.height))
    ops.push(`裁剪 ${roundRectText(crop)} → ${image.width}×${image.height}`)
  }

  // ③ 抠图 / 去背景(必须在贴图之前:先把主体从背景里切出来,再合成)
  let cutoutNote = ''
  const cutoutRaw = args.cutout as Record<string, unknown> | undefined
  if (cutoutRaw) {
    const bgRaw = cutoutRaw.background === undefined || cutoutRaw.background === null ? null : String(cutoutRaw.background)
    const background = bgRaw && bgRaw !== 'transparent' && bgRaw !== 'none' ? bgRaw : null
    const common = {
      background,
      trim: cutoutRaw.trim === true,
      featherPx: cutoutRaw.featherPx === undefined ? undefined : Math.max(0, readNum(cutoutRaw.featherPx)),
      padPercent: cutoutRaw.padPercent === undefined ? undefined : readNum(cutoutRaw.padPercent)
    }
    const maskAssetId = cutoutRaw.maskAssetId ? String(cutoutRaw.maskAssetId) : ''
    if (maskAssetId) {
      const maskAsset = db.asset(maskAssetId)
      if (!maskAsset) return { ok: false, text: `蒙版 ${maskAssetId} 不存在。`, assetIds: [] }
      const loadedMask = loadRgbaAsset(maskAssetId)
      if (!loadedMask.image) return { ok: false, text: '蒙版解码失败。', assetIds: [] }
      const res = cutoutWithMask(image, loadedMask.image, {
        ...common,
        ...(cutoutRaw.invertMask === true ? { invertMask: true } : {})
      })
      image = res.image
      sources.push(maskAssetId)
      ops.push(`按蒙版抠图 ${maskAssetId}(${background ? `底色 ${background}` : '透明背景'}${res.trimmed ? ' · 已裁紧' : ''} · 羽化 ${res.featherPx}px)`)
      if (res.coverage < 0.01) {
        return {
          ok: false,
          text: `蒙版几乎全被当成背景了(前景仅 ${(res.coverage * 100).toFixed(1)}%)。八成是极性反了:白底黑主体请传 invertMask:true,或让蒙版改成"白色=主体"。`,
          assetIds: []
        }
      }
      cutoutNote = `前景占 ${(res.coverage * 100).toFixed(1)}%`
      if (res.coverage > 0.985) {
        return {
          ok: false,
          text: `蒙版几乎整张都是主体(前景 ${(res.coverage * 100).toFixed(1)}%),基本等于没抠。八成是蒙版极性反了:如果蒙版是"白色背景 + 黑色主体",请传 invertMask:true;也可以让蒙版改成"白色=主体、黑色=背景"。`,
          assetIds: []
        }
      }
    } else {
      const startedAt = Date.now()
      const res = autoCutout(image, {
        ...common,
        ...(cutoutRaw.tolerance === undefined ? {} : { tolerance: readNum(cutoutRaw.tolerance, 30) }),
        ...(cutoutRaw.edgePercent === undefined ? {} : { edgePercent: readNum(cutoutRaw.edgePercent, 0.9) })
      })
      image = res.image
      ops.push(
        `自动抠图(容差 ${Math.round(readNum(cutoutRaw.tolerance, 30))}${background ? ` · 底色 ${background}` : ' · 透明背景'}${res.trimmed ? ' · 已裁紧' : ''} · 羽化 ${res.featherPx}px · ${Date.now() - startedAt}ms)`
      )
      // 只有"几乎没抠到"或"几乎没抠掉"才算失败;背景杂不乱不影响结果
      const bad = res.coverage < 0.03 || res.coverage > 0.97
      if (bad) {
        return {
          ok: false,
          text:
            `自动抠图失败:前景只剩 ${(res.coverage * 100).toFixed(1)}%,不是可用结果。` +
            `可以按顺序试:1) tolerance 调小(默认 30,改成 18)让泛洪不那么容易越界;2) edgePercent 调低(默认 0.9,改成 0.8)让更多边缘被当成墙;` +
            `3) 还是不行就换蒙版路线:用 edit_image 以原图为参考只生成一张**黑白剪影蒙版**(白=主体、黑=背景,不要内部细节),` +
            `再调 composite_image 的 cutout.maskAssetId 切同一张原图 —— 像素仍然来自原图。不要再让模型整图重画来冒充抠图。`,
          assetIds: []
        }
      }
      cutoutNote = `前景占 ${(res.coverage * 100).toFixed(1)}%,背景干净度 ${res.borderSpread.toFixed(0)}`
    }
  }

  // ④ 贴图
  const pasteRaw = args.paste as Record<string, unknown> | undefined
  if (pasteRaw && pasteRaw.assetId) {
    const pasteId = String(pasteRaw.assetId)
    const loadedPaste = loadRgbaAsset(pasteId)
    if (!loadedPaste.image) return { ok: false, text: loadedPaste.error ?? '贴图素材解码失败', assetIds: [] }
    const src = loadedPaste.image
    const to = readNormRect(pasteRaw.to)
    if (!to) return { ok: false, text: '粘贴位置 paste.to 需要给定 x/y/w/h(0-1 归一化,宽高 > 0)。', assetIds: [] }
    const fromRect = readNormRect(pasteRaw.from)
    const srcPx = fromRect
      ? normRectToPixels(fromRect, src.width, src.height)
      : (alphaBBox(src) ?? { x: 0, y: 0, w: src.width, h: src.height })
    const dstPx = normRectToPixels(to, image.width, image.height)
    const blendRaw = String(pasteRaw.blend ?? 'normal')
    const blend = blendRaw === 'multiply' || blendRaw === 'screen' ? blendRaw : 'normal'
    pasteImage(image, src, srcPx, dstPx, { opacity: readNum(pasteRaw.opacity, 1), blend })
    sources.push(pasteId)
    ops.push(
      `贴图 ${pasteId} 源像素 ${rectText(srcPx)} → 目标像素 ${rectText(dstPx)}${fromRect ? '' : '(自动取不透明主体)'}${
        blend === 'normal' ? '' : ` · ${blend}`
      }${readNum(pasteRaw.opacity, 1) < 1 ? ` · 透明度 ${(readNum(pasteRaw.opacity, 1) * 100).toFixed(0)}%` : ''}`
    )
  }

  // ⑤ 调色 / 局部换色
  const recolorRaw = args.recolor as Record<string, unknown> | undefined
  if (recolorRaw) {
    const maskAssetId = recolorRaw.maskAssetId ? String(recolorRaw.maskAssetId) : ''
    let mask: RgbaImage | null = null
    let maskRegion: 'opaque' | 'transparent' = 'transparent'
    if (maskAssetId) {
      const maskAsset = db.asset(maskAssetId)
      if (!maskAsset) return { ok: false, text: `蒙版 ${maskAssetId} 不存在。`, assetIds: [] }
      const loadedMask = loadRgbaAsset(maskAssetId)
      if (!loadedMask.image) return { ok: false, text: '蒙版解码失败。', assetIds: [] }
      mask = loadedMask.image
      // 应用的蒙版约定:透明=待改;其他图(如抠图 PNG 当遮罩)按不透明=生效处理
      maskRegion = maskAsset.kind === 'mask' ? 'transparent' : 'opaque'
      sources.push(maskAssetId)
    }
    const options = {
      mask: mask ?? undefined,
      maskRegion,
      hue: readNum(recolorRaw.hue, 0),
      saturation: readNum(recolorRaw.saturation, 1),
      lightness: readNum(recolorRaw.lightness, 0),
      contrast: readNum(recolorRaw.contrast, 1),
      temperature: readNum(recolorRaw.temperature, 0),
      preserveLuma: recolorRaw.preserveLuma === true
    }
    if (
      options.hue === 0 &&
      options.saturation === 1 &&
      options.lightness === 0 &&
      options.contrast === 1 &&
      options.temperature === 0
    ) {
      return { ok: false, text: 'recolor 没有给出任何调整值(至少给 hue/saturation/lightness/contrast/temperature 之一)。', assetIds: [] }
    }
    recolor(image, options)
    const parts: string[] = []
    if (options.hue) parts.push(`色相 ${options.hue > 0 ? '+' : ''}${options.hue}°`)
    if (options.saturation !== 1) parts.push(`饱和 ×${options.saturation}`)
    if (options.lightness) parts.push(`明度 ${options.lightness > 0 ? '+' : ''}${Math.round(options.lightness * 100)}%`)
    if (options.contrast !== 1) parts.push(`对比 ×${options.contrast}`)
    if (options.temperature) parts.push(`色温 ${options.temperature > 0 ? '+' : ''}${options.temperature}`)
    if (options.preserveLuma) parts.push('保持亮度')
    ops.push(`调色 ${maskAssetId ? `(仅蒙版 ${maskAssetId} 区域)` : '(整图)'}:${parts.join('、')}`)
  }

  // ⑥ 确定性局部换色(不重绘:只改写选中的像素,其余像素原样保留)
  let paintReport: ReturnType<typeof paintRegion>['report'] | undefined
  let paintWarn = ''
  const paintRaw = args.paint as Record<string, unknown> | undefined
  if (paintRaw) {
    const paintMaskId = paintRaw.maskAssetId ? String(paintRaw.maskAssetId) : ''
    let paintMask: RgbaImage | undefined
    if (paintMaskId) {
      const maskAsset = db.asset(paintMaskId)
      if (!maskAsset) return { ok: false, text: `换色蒙版 ${paintMaskId} 不存在。`, assetIds: [] }
      const loadedMask = loadRgbaAsset(paintMaskId)
      if (!loadedMask.image) return { ok: false, text: `换色蒙版 ${paintMaskId} 解码失败。`, assetIds: [] }
      paintMask = loadedMask.image
      sources.push(paintMaskId)
    }
    const from = paintRaw.targetFrom as Record<string, unknown> | undefined
    const hasTarget = Boolean(paintRaw.target) || Boolean(from)
    if (!hasTarget) {
      return { ok: false, text: 'paint 需要 target(#rrggbb)或 targetFrom(从图里取样),二者至少给一个。', assetIds: [] }
    }
    const paint = paintRegion(image, {
      ...(paintRaw.target ? { target: String(paintRaw.target) } : {}),
      ...(from ? { targetFrom: { x: readNum(from.x), y: readNum(from.y) } } : {}),
      ...(paintRaw.color ? { color: String(paintRaw.color) } : {}),
      ...(paintRaw.tolerance === undefined ? {} : { tolerance: readNum(paintRaw.tolerance, 42) }),
      ...(paintMask ? { mask: paintMask, maskKind: 'image' as const } : {}),
      ...(guardRectOf(paintRaw.region) ? { region: guardRectOf(paintRaw.region) as GuardRect } : {}),
      ...(Array.isArray(paintRaw.exclude)
        ? {
            exclude: (paintRaw.exclude as unknown[])
              .map((item) => guardRectOf(item))
              .filter((item): item is GuardRect => Boolean(item))
          }
        : {}),
      ...(paintRaw.maskGrow === undefined ? {} : { growPx: Math.max(0, Math.min(16, readNum(paintRaw.maskGrow))) }),
      mode: paintRaw.mode === 'shade' ? 'shade' : 'albedo',
      ...(paintRaw.highlightProtect === undefined ? {} : { highlightProtect: Math.max(0, Math.min(1, readNum(paintRaw.highlightProtect, 0))) }),
      ...(paintRaw.shadowLift === undefined ? {} : { shadowLift: Math.max(0, Math.min(1, readNum(paintRaw.shadowLift, 0))) }),
      preserveShading: paintRaw.preserveShading !== false,
      ...(paintRaw.strength === undefined ? {} : { strength: readNum(paintRaw.strength, 1) }),
      ...(paintRaw.featherPx === undefined ? {} : { featherPx: readNum(paintRaw.featherPx, 2) })
    })
    image = paint.image
    paintReport = paint.report
    const paintTargetHex = hexOf(paint.report.target)
    const paintSourceHex = hexOf(paint.report.sourceMean)
    if (paint.report.painted < 16) {
      return {
        ok: false,
        text:
          `换色没命中任何像素(容差 ${readNum(paintRaw.tolerance, 42)}):` +
          `如果指定了 color,请确认色号和容差;如果给了 region/mask,请确认区域里确实有这部分颜色。可以用 inspect_grid 先取色。`,
        assetIds: []
      }
    }
    // 目标色 ≈ 选中像素的平均色 = 刷了等于没刷。实测中模型会把取样点落在"要改的键帽"上,白刷一轮。
    if (
      Math.abs(paint.report.target[0] - paint.report.sourceMean[0]) <= 8 &&
      Math.abs(paint.report.target[1] - paint.report.sourceMean[1]) <= 8 &&
      Math.abs(paint.report.target[2] - paint.report.sourceMean[2]) <= 8
    ) {
      return {
        ok: false,
        text:
          `换色目标 ${paintTargetHex} 和选中的像素平均色 ${paintSourceHex} 几乎一样,刷了等于没刷。` +
          `targetFrom 取样点多半落在"要改的那部分"上了:请从**外壳/主体/参照物**取样(例如键盘外壳、背景里已经正确的颜色),不要从要改的键帽上取。`,
        assetIds: []
      }
    }
    if (paint.report.coverage < 0.005) {
      return {
        ok: false,
        text:
          `换色只命中 ${(paint.report.coverage * 100).toFixed(2)}%(${paint.report.painted} 像素),基本等于没改:` +
          `请检查 color 色号/tolerance(命中率低通常是容差太小)、region 是否画偏、mask 是否反了。` +
          `可以先用 inspect_grid 放大目标区域,确认要改的颜色和位置。`,
        assetIds: []
      }
    }
    if (paint.report.coverage < 0.02) {
      paintWarn = `注意:只命中 ${(paint.report.coverage * 100).toFixed(2)}%,请确认选区/容差是否符合预期。`
    }
    ops.push(
      `${paint.report.mode === 'albedo' ? '材质换色(反照率)' : '局部换色'} → ${paintTargetHex}:覆盖 ${(paint.report.coverage * 100).toFixed(1)}%(${paint.report.painted} 像素${
        paintRaw.color ? `,只选 ${String(paintRaw.color)} 附近` : ''
      }${
        paintRaw.preserveShading === false
          ? ' · 纯色'
          : paint.report.mode === 'albedo'
            ? paint.report.highlightRetention && paint.report.highlightRetention > 0.02
              ? ` · 高光保留 ${Math.round(paint.report.highlightRetention * 100)}%`
              : ' · 哑光'
            : ' · 保留明暗'
      })`
    )
  }

  // ⑦ 圆角 / 描边
  const cornersRaw = args.corners as Record<string, unknown> | undefined
  if (cornersRaw && cornersRaw.radius !== undefined) {
    const ratio = Math.min(0.5, Math.max(0, readNum(cornersRaw.radius)))
    const radius = ratio * Math.min(image.width, image.height)
    const stroke = Math.max(0, readNum(cornersRaw.stroke))
    image = roundCorners(image, radius, {
      stroke: stroke || undefined,
      strokeColor: parseColor(cornersRaw.strokeColor) ?? [0, 0, 0, 255],
      background: parseColor(cornersRaw.background) ?? undefined
    })
    ops.push(`圆角 r=${Math.round(radius)}px${stroke ? ` 描边 ${Math.round(stroke)}px` : ''}${cornersRaw.background ? ` 底色 ${String(cornersRaw.background)}` : ''}`)
  }

  // ⑦ 画布尺寸
  const canvasRaw = args.canvas as Record<string, unknown> | undefined
  if (canvasRaw && (canvasRaw.width || canvasRaw.height)) {
    const width = Math.max(1, Math.round(readNum(canvasRaw.width, image.width)))
    const height = Math.max(1, Math.round(readNum(canvasRaw.height, image.height)))
    image = expandCanvas(image, width, height, parseColor(canvasRaw.fill) ?? undefined)
    ops.push(`画布 ${image.width}×${image.height}`)
  }

  if (!ops.length) {
    return {
      ok: false,
      text: '没有可执行的合成操作:cutout / crop / paste / recolor / corners / canvas / collage 至少给一个。',
      assetIds: []
    }
  }

  const label = String(args.label ?? '').trim()
  // inspect:纯分析用(放大某个区域看细节)—— 归到 annotation,不进版本树、不占版本链
  const inspectOnly = args.inspect === true
  let buffer: Buffer
  try {
    buffer = encodeRgba(image, 'png')
  } catch (err) {
    return { ok: false, text: `编码失败:${errText(err)}`, assetIds: [] }
  }
  const newAsset = saveBufferAsset({
    sessionId: ctx.sessionId,
    buffer,
    mime: 'image/png',
    kind: inspectOnly ? 'annotation' : 'edited',
    baseAssetId: inspectOnly ? base.id : undefined,
    parentId: base.id,
    prompt: inspectOnly ? `分析用放大:${label || ops.join(';')}` : label ? `本地合成:${label}` : `本地合成:${ops.join(';')}`,
    meta: {
      local: true,
      ops,
      sourceAssetIds: [...new Set(sources)],
      cost: 0,
      actualSize: `${image.width}x${image.height}`,
      editedFrom: [base.id],
      originAssetId: originOf(base.id),
      ...(paintReport ? { paint: paintReport } : {}),
      ...(inspectOnly ? { inspect: true } : {})
    }
  })
  ctx.emit({ type: 'asset-added', sessionId: ctx.sessionId, asset: newAsset })
  const head = inspectOnly
    ? `已生成分析用局部图(不进版本树):${ops.join(';')}。图片 ${newAsset.id},尺寸 ${image.width}×${image.height}。它是原图像素直接裁剪,没有重绘。`
    : `已本地合成(未调用生图服务,¥0):${ops.join(';')}。新图 ${newAsset.id},尺寸 ${image.width}×${image.height}(${fmtSize(
        buffer.length
      )})。这是像素级操作、没有重新绘制 —— 如果光影/质感需要与底图融合更自然,可再用 edit_image 局部微调。`
  const paintNote = paintReport
    ? `换色是"逐像素改写",没有重绘:命中 ${paintReport.painted} 像素(${(paintReport.coverage * 100).toFixed(1)}%),这些像素以外逐字节未变 —— 键位/布局/徽标形状不可能被改。${
        paintReport.mode === 'albedo'
          ? paintReport.highlightRetention && paintReport.highlightRetention > 0.02
            ? `材质换色保留了原图 ${Math.round(paintReport.highlightRetention * 100)}% 的高光,看起来是同一种塑料换了颜色。`
            : '按反照率换色(哑光):只把漫反射换成目标色,阴影和边缘仍由原光照决定,不是盖一层颜色。'
          : '这是明暗染色模式;如果看起来像涂层,改用 mode:"albedo"。'
      }${(() => {
        // 白色→深色这类大幅变暗:逐像素等比缩放会把亮面和暗面一起压扁,看起来像上了一层色。
        // 这不是参数能救的,得让模型重画材质。
        if (!paintReport) return ''
        const srcL = 0.2126 * paintReport.sourceMean[0] + 0.7152 * paintReport.sourceMean[1] + 0.0722 * paintReport.sourceMean[2]
        const dstL = 0.2126 * paintReport.target[0] + 0.7152 * paintReport.target[1] + 0.0722 * paintReport.target[2]
        if (dstL <= 0 || srcL / dstL < 2.2) return ''
        return `\n注意:源区域平均亮度 ${srcL.toFixed(0)} → 目标 ${dstL.toFixed(0)}(暗了 ${(srcL / dstL).toFixed(1)} 倍)。这种"大面积变深一个数量级"只是把颜色改掉,材质(高光形状、塑料质感)还是原来的白色件;如果用户要的是"这件东西本来就是黑塑料",请改用 edit_image + protect:{auto:true} 让模型重画材质。`
      })()}`
    : ''
  return {
    ok: true,
    text: `${head}${paintNote}${paintWarn ? paintWarn : ''}${cutoutNote && !inspectOnly ? `抠图诊断:${cutoutNote}。` : ''}`,
    assetIds: [newAsset.id]
  }
}

export function execCompareImage(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const db = getDb()
  const assetId = String(args.assetId ?? '').trim()
  if (!assetId) return { ok: false, text: '参数错误:assetId 必填', assetIds: [] }
  const current = db.asset(assetId)
  if (!current) return { ok: false, text: `图片 ${assetId} 不存在。`, assetIds: [] }
  const baselineId = args.baselineAssetId ? String(args.baselineAssetId) : originOf(assetId)
  const baselineAsset = db.asset(baselineId)
  if (!baselineAsset) return { ok: false, text: `基线图 ${baselineId} 不存在。`, assetIds: [] }
  const baseLoaded = loadRgbaAsset(baselineId)
  if (!baseLoaded.image) return { ok: false, text: baseLoaded.error ?? '基线图解码失败', assetIds: [] }
  const curLoaded = loadRgbaAsset(assetId)
  if (!curLoaded.image) return { ok: false, text: curLoaded.error ?? '当前图解码失败', assetIds: [] }

  const maskId = args.maskAssetId ? String(args.maskAssetId) : ''
  let mask: RgbaImage | undefined
  let maskKind: 'user' | 'image' = 'image'
  if (maskId) {
    const maskAsset = db.asset(maskId)
    if (!maskAsset) return { ok: false, text: `蒙版 ${maskId} 不存在。`, assetIds: [] }
    const loaded = loadRgbaAsset(maskId)
    if (!loaded.image) return { ok: false, text: loaded.error ?? '蒙版解码失败', assetIds: [] }
    mask = loaded.image
    maskKind = maskAsset.kind === 'mask' ? 'user' : 'image'
  }
  const region = guardRectOf(args.region)
  const wantHeatmap = args.heatmap === true
  const res = compareWithBaseline(baseLoaded.image, curLoaded.image, {
    ...(region ? { region } : {}),
    ...(mask ? { mask, maskKind } : {}),
    heatmap: wantHeatmap,
    baselineAssetId: baselineId
  })
  const report = res.report
  const assetIds: string[] = []
  let heatNote = ''
  if (res.heatmap) {
    const buffer = encodeRgba(res.heatmap, 'png')
    const heatAsset = saveBufferAsset({
      sessionId: ctx.sessionId,
      buffer,
      mime: 'image/png',
      kind: 'annotation',
      parentId: assetId,
      baseAssetId: assetId,
      prompt: `差异热图:${baselineId} → ${assetId}`,
      meta: {
        local: true,
        inspect: true,
        ops: ['差异热图:红=允许区域内改动,黄=区域外不该有的改动'],
        actualSize: `${res.heatmap.width}x${res.heatmap.height}`,
        editedFrom: [assetId],
        originAssetId: originOf(assetId),
        cost: 0
      }
    })
    ctx.emit({ type: 'asset-added', sessionId: ctx.sessionId, asset: heatAsset })
    assetIds.push(heatAsset.id)
    heatNote = `差异热图 ${heatAsset.id}(红=区域内改动,黄=区域外改动)。`
  }
  const pct = (v: number): string => `${(v * 100).toFixed(2)}%`
  const islands = report.outsideRegions.length
    ? `区域外改动聚集在:${report.outsideRegions
        .map((r) => `x ${r.x.toFixed(2)}-${(r.x + r.w).toFixed(2)}, y ${r.y.toFixed(2)}-${(r.y + r.h).toFixed(2)}(占 ${pct(r.share)})`)
        .join('、')}`
    : '区域外没有成块改动'
  const anchor = report.edgeAnchor === null ? '边界太少,无法判断' : report.edgeAnchor.toFixed(2)
  const advice =
    report.verdict === 'ok'
      ? '结论:改动方向与范围符合预期'
      : `结论:保真可疑 —— ${
          report.modelOutsideChangedRatio > 0.02 ? '模型改到了允许区域外' : '区域内出现大量原图没有的新边界(重绘/位移特征)'
        };建议用 protect 重跑,纯换色改用 paint`
  return {
    ok: true,
    text:
      `比对:${assetId} vs 基线 ${baselineId}(${baselineAsset.width ?? '?'}×${baselineAsset.height ?? '?'})。` +
      `允许区域占 ${pct(report.allowedCoverage)};区域内改动 ${pct(report.insideChangedRatio)};` +
      `区域外改动 ${pct(report.deliveredOutsideChangedRatio)},${islands};边界锚定 ${anchor}。${advice}。${heatNote}`,
    assetIds
  }
}

export function execInspectGrid(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const assetId = String(args.assetId ?? '').trim()
  if (!assetId) return { ok: false, text: '参数错误:assetId 必填', assetIds: [] }
  const loaded = loadRgbaAsset(assetId)
  if (!loaded.image) return { ok: false, text: loaded.error ?? '解码失败', assetIds: [] }
  const cells = Math.max(2, Math.min(20, Math.round(readNum(args.cells, 10))))
  const image = guardSize(loaded.image).image
  drawGrid(image, { cells })
  const buffer = encodeRgba(image, 'png')
  const newAsset = saveBufferAsset({
    sessionId: ctx.sessionId,
    buffer,
    mime: 'image/png',
    kind: 'annotation',
    baseAssetId: assetId,
    parentId: assetId,
    prompt: `坐标网格标注(${cells}×${cells})`,
    meta: { local: true, ops: [`坐标网格 ${cells}×${cells}`], sourceAssetIds: [assetId], cost: 0 }
  })
  ctx.emit({ type: 'asset-added', sessionId: ctx.sessionId, asset: newAsset })
  return {
    ok: true,
    text: `已生成 ${cells}×${cells} 坐标网格图 ${newAsset.id}(每格 ${(100 / cells).toFixed(2).replace(/\.?0+$/, '')}% = ${(
      1 / cells
    ).toFixed(3)} 归一化)。按它数格子,把要贴图/裁剪的矩形换算成 0-1 比例传给 composite_image。`,
    assetIds: [newAsset.id]
  }
}

// ---------- 用户提问 ----------

import { randomUUID } from 'node:crypto'
import type { AgentQuestion, AgentQuestionOption } from '@shared/types'
import { askUser } from './askUser'

export async function execAskUser(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const text = String(args.question ?? '').trim()
  if (!text) return { ok: false, text: '参数错误:question 不能为空', assetIds: [] }
  const rawOptions = Array.isArray(args.options) ? (args.options as Record<string, unknown>[]) : []
  const options: AgentQuestionOption[] = rawOptions
    .map((o) => ({
      label: String(o.label ?? '').trim(),
      description: o.description ? String(o.description) : undefined,
      recommended: o.recommended === true
    }))
    .filter((o) => o.label)
  if (options.length < 2) {
    return { ok: false, text: '参数错误:选择题至少需要 2 个选项;开放性问题请改用纯文本向用户提问。', assetIds: [] }
  }
  if (options.filter((o) => o.recommended).length !== 1) {
    return { ok: false, text: '参数错误:必须恰好一个选项 recommended=true(推荐答案)。', assetIds: [] }
  }

  const question: AgentQuestion = {
    id: `q-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    text,
    options,
    allowFreeText: true
  }
  ctx.emit({ type: 'ask-user', sessionId: ctx.sessionId, question })
  const answer = await askUser(ctx.sessionId, question)
  if (answer.startsWith('用户未回答')) {
    return { ok: true, text: `${answer}。请停止调整,直接总结当前结果收尾。`, assetIds: [] }
  }
  return { ok: true, text: `用户选择:"${answer}"。请以该选择为准继续。`, assetIds: [] }
}

// ---------- 分发 ----------

export async function executeTool(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'update_brief':
        return execUpdateBrief(ctx, args)
      case 'generate_image':
        return await execGenerateImage(ctx, args)
      case 'edit_image':
        return await execEditImage(ctx, args)
      case 'list_directory':
        return execListDirectory(ctx, args)
      case 'read_file':
        return execReadFile(ctx, args)
      case 'import_image':
        return execImportImage(ctx, args)
      case 'write_file':
        return execWriteFile(ctx, args)
      case 'edit_file':
        return execEditFile(ctx, args)
      case 'process_image':
        return execProcessImage(ctx, args)
      case 'composite_image':
        return execCompositeImage(ctx, args)
      case 'compare_image':
        return execCompareImage(ctx, args)
      case 'inspect_grid':
        return execInspectGrid(ctx, args)
      case 'move_file':
        return execMoveFile(ctx, args)
      case 'copy_file':
        return execCopyFile(ctx, args)
      case 'ask_user':
        return await execAskUser(ctx, args)
      default:
        return { ok: false, text: `未知工具:${name}`, assetIds: [] }
    }
  } catch (err) {
    return { ok: false, text: `工具执行失败:${errText(err)}`, assetIds: [] }
  }
}
