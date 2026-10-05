/** Trusted, version-pinned runtime shared by all supported imports in a preview. */
// Explicit exports keep the bundled CommonJS React package visible as ESM names.
export {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} from 'react';
import React from 'react';
export default React;
export { createRoot, hydrateRoot } from 'react-dom/client';
export { jsx, jsxs } from 'react/jsx-runtime';
export { jsxDEV } from 'react/jsx-dev-runtime';
