---
id: rule-ui-aesthetic-precision
title: iOS 克制艺术与白色精密数学工程界面规范
category: design/ui
priority: critical
summary: 确立以高对比白底、8pt 数学网格、发丝细线与 iOS 克制排版为核心的工程视觉语言。
---

# iOS 克制艺术与白色精密数学工程界面规范

## 1. 核心设计哲学 (Core Philosophy)
ContextOS 桌面工作区并非普通消费级应用，而是服务于高强度 AI 编程与系统架构审视的**精密数学工程仪器**。
UI 设计全盘继承 iOS 与 macOS 平台级的**克制设计哲学 (Restraint Aesthetics)**，杜绝过度渐变、杂乱毛玻璃与炫目动效，以信息密度、几何精密感与排版节奏感为第一优先级。

## 2. 视觉基准与数学网格 (Mathematical Precision Grid)
- **纯白与极浅冷灰工作台**：主画布与操作区使用坚实纯白背景（#FFFFFF / #FBFBFD），边框使用 0.5pt/1pt 超精细单像素发丝分割线（Hairline Border #E5E5EA）。
- **8pt 模数网格**：所有组件尺寸、间距、填充严格遵循 4pt / 8pt / 16pt / 24pt 的数学倍数，确保跨分辨率下的几何严丝合缝。
- **字体排印与等宽度量**：文本采用 Apple SF Pro 作为界面字体，数字、哈希、链路 ID、状态码严格使用 SF Mono 纯等宽字体，提供精密工程仪表的读数体验。

## 3. Metro 地铁轨道式导轨 (Orthogonal Metro Rails)
- **水平主干道**：架构主链路在画布上映射为清晰水平轨道线，禁止混乱交叉的非正交折线。
- **90 度正交换乘廊道**：跨链路调用与 Link 关系严格使用 90 度圆角折线转弯（Orthogonal Routing），视觉关系一目了然。
- **胶囊包裹区**：链路成员以圆角半透明导轨胶囊统一包裹，清晰定义架构作用域。

## 4. 功能性克制色彩 (Calm Functional Palette)
- 严禁非语义性装饰色，每种色彩只代表唯一的系统状态：
  - **通行绿 (Traffic Green #34C759)**：验证通过、状态就绪、测试通过。
  - **冷核蓝 (Calm Cobalt #007AFF)**：当前聚焦、主干链路、代码流转。
  - **静谧紫 (Muted Indigo #5856D6)**：MCP 协议、网关服务、外部契约。
  - **警示橙 (Precision Amber #FF9500)**：待补充验证、警告、中间态。
  - **故障红 (System Crimson #FF3B30)**：测试失败、断言失败、不可用。
