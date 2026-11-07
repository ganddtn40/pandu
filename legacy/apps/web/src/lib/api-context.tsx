import { createContext, useContext, type ReactNode } from 'react';

import { defaultApiClient, type ApiClient } from './api';

const ApiContext = createContext<ApiClient>(defaultApiClient);

export interface ApiProviderProps {
  children: ReactNode;
  client?: ApiClient;
}

export function ApiProvider({ children, client = defaultApiClient }: ApiProviderProps) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApiClient(): ApiClient {
  return useContext(ApiContext);
}
