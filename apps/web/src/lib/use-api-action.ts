import { useCallback, useRef, useState } from 'react';
import { ApiAction, ApiError, api, type ApiRequest } from './api';

export type ActionState<T> =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: ApiError };

/**
 * One user action (a "Hold $229" button, a form). `run()` is the first attempt and every retry of
 * that action, and they share one Idempotency-Key; call `reset()` when the user starts a new
 * action (e.g. after a success, or when they close the form). See `ApiAction` for the key rules.
 */
export function useApiAction<T>() {
  const action = useRef<ApiAction | null>(null);
  action.current ??= new ApiAction(api);
  const [state, setState] = useState<ActionState<T>>({ status: 'idle' });

  const run = useCallback(async (req: ApiRequest): Promise<T | undefined> => {
    setState({ status: 'pending' });
    try {
      const data = await action.current!.run<T>(req);
      setState({ status: 'success', data });
      return data;
    } catch (err) {
      const error =
        err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.');
      setState({ status: 'error', error });
      return undefined;
    }
  }, []);

  const reset = useCallback(() => {
    action.current!.reset();
    setState({ status: 'idle' });
  }, []);

  return { ...state, run, reset };
}
