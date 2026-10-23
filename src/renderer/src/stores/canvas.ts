// 画布状态:当前查看的图 + 编号画笔蒙版(归一化笔迹,双图导出:二值蒙版给接口、彩色标注给模型)

import { create } from 'zustand'
import type { MaskStroke } from '../lib/mask'

interface CanvasStore {
  baseAssetId: string | null
  /** 归一化笔迹(相对底图宽高),与显示分辨率无关 */
  strokes: MaskStroke[]
  /** 侧栏小画布是否处于涂抹模式 */
  brushMode: boolean
  activeBrushId: number
  /** 画笔显示直径(px,以 720px 宽的编辑视图为基准,内部换算归一化) */
  brushSize: number
  /** 蒙版羽化像素(0 = 硬边) */
  featherPx: number
  /** 接口用二值蒙版(透明=待修改) */
  maskDataUrl: string | null
  /** 模型看的彩色编号标注图 */
  overlayDataUrl: string | null
  maskBaseAssetId: string | null
  editorOpen: boolean
  /** 多比例导出面板 */
  exportOpen: boolean
  /** A/B 对比:选两张图并排看 */
  compareMode: boolean
  compareA: string | null
  compareB: string | null
  setBase: (assetId: string | null) => void
  setBrushMode: (on: boolean) => void
  setActiveBrush: (id: number) => void
  setBrushSize: (size: number) => void
  setFeather: (px: number) => void
  /** 删除某个编号的全部笔迹 */
  removeBrush: (brushId: number) => void
  /** 追加/更新一笔(同一笔移动中重复传末笔) */
  upsertStroke: (stroke: MaskStroke, isUpdate: boolean) => void
  undo: () => void
  clearStrokes: () => void
  /** 双图导出结果回填(防抖后由组件调用) */
  setMaskOutput: (mask: string | null, overlay: string | null) => void
  clearMask: () => void
  setEditorOpen: (open: boolean) => void
  setExportOpen: (open: boolean) => void
  toggleCompare: () => void
  /** 对比模式下点选:先 A 后 B,重复点同一个则取消 */
  pickCompare: (assetId: string) => void
  clearCompare: () => void
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  baseAssetId: null,
  strokes: [],
  brushMode: false,
  activeBrushId: 1,
  brushSize: 28,
  featherPx: 0,
  maskDataUrl: null,
  overlayDataUrl: null,
  maskBaseAssetId: null,
  editorOpen: false,
  exportOpen: false,
  compareMode: false,  compareA: null,
  compareB: null,

  setBase: (assetId) => {
    if (get().maskBaseAssetId !== assetId) {
      set({ baseAssetId: assetId, strokes: [], maskDataUrl: null, overlayDataUrl: null, maskBaseAssetId: null })
    } else {
      set({ baseAssetId: assetId })
    }
  },

  setBrushMode: (on) => set({ brushMode: on }),
  setActiveBrush: (id) => set({ activeBrushId: id }),
  setBrushSize: (size) => set({ brushSize: Math.min(240, Math.max(4, Math.round(size))) }),
  setFeather: (px) => set({ featherPx: Math.min(60, Math.max(0, Math.round(px))) }),
  removeBrush: (brushId) => set({ strokes: get().strokes.filter((s) => s.brushId !== brushId) }),

  upsertStroke: (stroke, isUpdate) => {
    const strokes = [...get().strokes]
    if (isUpdate && strokes.length) strokes[strokes.length - 1] = stroke
    else strokes.push(stroke)
    set({ strokes })
  },

  undo: () => set({ strokes: get().strokes.slice(0, -1) }),
  clearStrokes: () => set({ strokes: [] }),

  setMaskOutput: (mask, overlay) => set({ maskDataUrl: mask, overlayDataUrl: overlay, maskBaseAssetId: mask ? get().baseAssetId : null }),

  clearMask: () => set({ maskDataUrl: null, overlayDataUrl: null, maskBaseAssetId: null, strokes: [] }),

  setEditorOpen: (open) => set({ editorOpen: open }),
  setExportOpen: (open) => set({ exportOpen: open }),

  toggleCompare: () => {
    const on = !get().compareMode
    set(on ? { compareMode: true } : { compareMode: false, compareA: null, compareB: null })
  },

  pickCompare: (assetId) => {
    if (!get().compareMode) return
    const { compareA, compareB } = get()
    if (compareA === assetId) return set({ compareA: null })
    if (compareB === assetId) return set({ compareB: null })
    if (!compareA) return set({ compareA: assetId })
    set({ compareB: assetId })
  },

  clearCompare: () => set({ compareMode: false, compareA: null, compareB: null })
}))
