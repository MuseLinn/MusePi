/** 组件样式旁路导入：宿主编译器把 `./x.css` 链提取成单独产物注入 <style>，
 * 类型层面只需承认这个通配。 */
declare module "*.css";
