import { useCallback, useState } from 'react';

export function useGit() {
  const [ready] = useState(true);

  const gitClone = useCallback(async (_url: string) => {
    return { workdir: '/home/project', data: {} };
  }, []);

  return { ready, gitClone };
}
