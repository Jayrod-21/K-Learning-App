/**
 * Tiny class-name combiner. Filters out falsy values without pulling in a
 * dependency. Use for conditional class strings on bones components.
 */
export function cn(
  ...parts: ReadonlyArray<string | false | null | undefined>
): string {
  return parts.filter((p): p is string => Boolean(p)).join(' ');
}
