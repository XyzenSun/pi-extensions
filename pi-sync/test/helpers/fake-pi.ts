export type NotificationLevel = "info" | "warning" | "error";

export interface Notification {
	message: string;
	level: NotificationLevel;
}

export interface StatusUpdate {
	key: string;
	value: unknown;
}

export interface RegisteredCommand {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{
		value: string;
		label: string;
		description?: string;
	}> | null;
	handler: (
		args: string | undefined,
		context: FakeCommandContext,
	) => Promise<void> | void;
}

export class FakeUi {
	readonly notifications: Notification[] = [];
	readonly statusUpdates: StatusUpdate[] = [];
	readonly confirmCalls: Array<{ title: string; message: string }> = [];
	readonly inputCalls: Array<{ title: string; placeholder?: string }> = [];
	readonly selectCalls: Array<{ title: string; options: unknown[] }> = [];
	private readonly terminalInputHandlers: Array<
		(data: string) => { consume?: boolean; data?: string } | undefined
	> = [];
	readonly theme = {
		fg: (_role: string, text: string) => text,
	};
	confirmResponses: boolean[] = [];
	inputResponses: Array<string | undefined> = [];
	selectResponses: Array<string | undefined> = [];

	setStatus(key: string, value: unknown): void {
		this.statusUpdates.push({ key, value });
	}

	notify(message: string, level: NotificationLevel): void {
		this.notifications.push({ message, level });
	}

	onTerminalInput(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		this.terminalInputHandlers.push(handler);
		return () => {
			const index = this.terminalInputHandlers.indexOf(handler);
			if (index >= 0) this.terminalInputHandlers.splice(index, 1);
		};
	}

	emitTerminalInput(data: string): void {
		for (const handler of [...this.terminalInputHandlers]) handler(data);
	}

	async confirm(title: string, message: string): Promise<boolean> {
		this.confirmCalls.push({ title, message });
		return this.confirmResponses.shift() ?? false;
	}

	async input(
		title: string,
		placeholder?: string,
	): Promise<string | undefined> {
		this.inputCalls.push({ title, placeholder });
		return this.inputResponses.shift();
	}

	async select(title: string, options: unknown[]): Promise<string | undefined> {
		this.selectCalls.push({ title, options });
		return this.selectResponses.shift();
	}

	async custom<T>(_renderer: unknown): Promise<T | undefined> {
		return undefined;
	}
}

export class FakeCommandContext {
	ui: FakeUi;
	readonly mode: "tui" | "rpc";
	hasUI = true;
	idle = true;
	reloadCalls = 0;
	reloadError: Error | undefined;

	constructor(mode: "tui" | "rpc" = "tui") {
		this.ui = new FakeUi();
		this.mode = mode;
	}

	isIdle(): boolean {
		return this.idle;
	}

	async reload(): Promise<void> {
		this.reloadCalls += 1;
		if (this.reloadError) throw this.reloadError;
	}
}

export type EventHandler = (
	event: unknown,
	context: FakeCommandContext,
) => unknown;

export class FakeExtensionApi {
	readonly commands = new Map<string, RegisteredCommand>();
	readonly eventHandlers = new Map<string, EventHandler[]>();
	readonly sentUserMessages: Array<{
		content: string;
		options?: { deliverAs?: "steer" | "followUp" };
	}> = [];

	sendUserMessage(
		content: string,
		options?: { deliverAs?: "steer" | "followUp" },
	): void {
		this.sentUserMessages.push({ content, options });
	}

	registerCommand(name: string, command: RegisteredCommand): void {
		this.commands.set(name, command);
	}

	on(event: string, handler: EventHandler): void {
		const handlers = this.eventHandlers.get(event) ?? [];
		handlers.push(handler);
		this.eventHandlers.set(event, handlers);
	}

	async emit(
		event: string,
		payload: unknown,
		context: FakeCommandContext,
	): Promise<void> {
		for (const handler of this.eventHandlers.get(event) ?? []) {
			await handler(payload, context);
		}
	}
}
