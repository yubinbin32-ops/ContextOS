import React from 'react';
import { ContentView } from './components/ContentView';
import { globalStore } from './graphStore';

export const App: React.FC = () => {
  return <ContentView store={globalStore} />;
};

export default App;
