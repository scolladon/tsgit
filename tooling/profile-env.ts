// Env-isolation idiom shared by every profiler surface that spawns `git` or
// writes through the library: scrub inherited GIT_* (a parent process or
// husky hook can export GIT_DIR, silently redirecting writes to the wrong
// repo), then pin a fixed identity so captured profiles are reproducible.

const PROFILE_IDENTITY_NAME = 'profile';
const PROFILE_IDENTITY_EMAIL = 'profile@tsgit.invalid';

const stripGitEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));

export const profileEnv = (): NodeJS.ProcessEnv => ({
  ...stripGitEnv(process.env),
  GIT_AUTHOR_NAME: PROFILE_IDENTITY_NAME,
  GIT_AUTHOR_EMAIL: PROFILE_IDENTITY_EMAIL,
  GIT_COMMITTER_NAME: PROFILE_IDENTITY_NAME,
  GIT_COMMITTER_EMAIL: PROFILE_IDENTITY_EMAIL,
  GIT_CONFIG_NOSYSTEM: '1',
});

export const withPinnedDate = (env: NodeJS.ProcessEnv, epochSeconds: number): NodeJS.ProcessEnv => {
  const date = `${epochSeconds} +0000`;
  return {
    ...env,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
};
