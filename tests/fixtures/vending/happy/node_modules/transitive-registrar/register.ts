export const calls = { count: 0 };

export function register(): void {
	calls.count += 1;
}
