import { AsyncLocalStorage } from "node:async_hooks";

const operationSignalContext = new AsyncLocalStorage<AbortSignal>();

/** 在一个取消信号下运行单条命令，嵌套操作会继承该信号。 */
export function withOperationSignal<T>(
	signal: AbortSignal | undefined,
	operation: () => Promise<T>,
): Promise<T> {
	return signal ? operationSignalContext.run(signal, operation) : operation();
}

/** 返回当前命令的取消信号（若存在）。 */
export function getOperationSignal(): AbortSignal | undefined {
	return operationSignalContext.getStore();
}
