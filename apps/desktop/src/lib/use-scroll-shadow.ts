/**
 * 桌面端滚动羽化的归家出口。实现在 client-ui-primitives
 * (`src/client/scroll-shadow.ts`),desktop-app 从这里 re-export 以保持既有
 * import 路径稳定——该 hook 现为双方向实现(纵向 + 横向 data 属性)。
 */
export { useScrollShadow } from "@musepi/client-ui-primitives/client";
