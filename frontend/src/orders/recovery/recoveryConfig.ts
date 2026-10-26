export function getRecoveryLayout(width: number) {
  return width <= 680 ? "single" : width < 1000 ? "double" : width < 1200 ? "three" : "four";
}
