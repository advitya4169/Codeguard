import { createHash, randomBytes } from 'node:crypto';
import User from '../models/User.js';
import Installation from '../models/Installation.js';
import GitHubAppOAuthState from '../models/GitHubAppOAuthState.js';
import {
  exchangeGitHubAppAuthorizationCode,
  getGitHubAppAuthorizationUrl,
  getGitHubAppAuthorizedUser,
  getGitHubAppInstallation,
  getGitHubAppUserInstallation,
} from '../services/githubAppService.js';

const STATE_LIFETIME_MS = 10 * 60 * 1000;

const stateDigest = (state) => createHash('sha256').update(state).digest('hex');

const getFrontendUrl = () =>
  (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

const dashboardResultUrl = (result) => {
  const url = new URL(`${getFrontendUrl()}/dashboard`);
  url.searchParams.set('github_app', result);
  return url.toString();
};

const parseInstallUrl = () => {
  const configuredUrl = process.env.GITHUB_APP_INSTALL_URL;
  if (!configuredUrl) throw new Error('GitHub App installation is not configured.');

  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error('GitHub App installation configuration is invalid.');
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    !/^\/apps\/[a-zA-Z0-9-]+\/installations\/new\/?$/.test(url.pathname)
  ) {
    throw new Error('GitHub App installation configuration is invalid.');
  }

  return url;
};

const isValidState = (state) =>
  typeof state === 'string' && /^[A-Za-z0-9_-]{43}$/.test(state);

const isUnexpired = (stateRecord, now) =>
  stateRecord?.expiresAt && new Date(stateRecord.expiresAt).getTime() > now.getTime();

const sameUser = (left, right) => String(left?._id ?? left) === String(right?._id ?? right);

const safeErrorCategory = (error) => {
  if (Number.isInteger(error?.status)) return `http_${error.status}`;
  if (error?.code === 11000) return 'duplicate_key';
  if (error?.name === 'MongoServerError') return 'database_error';
  if (error?.name === 'ValidationError') return 'validation_error';
  if (error?.name === 'TypeError') return 'type_error';
  return 'operation_failed';
};

const logCallbackDiagnostic = (stage, category) => {
  console.warn('GitHub App callback diagnostic', { stage, category });
};

const installationFields = (metadata) => ({
  accountId: metadata.accountId,
  accountLogin: metadata.accountLogin,
  ...(metadata.accountName ? { accountName: metadata.accountName } : {}),
  accountType: metadata.accountType,
  status: metadata.suspendedAt ? 'suspended' : 'active',
});

/** Dependency injection keeps the callback flow testable without a live database or GitHub. */
export const createGitHubAppController = ({
  UserModel = User,
  InstallationModel = Installation,
  StateModel = GitHubAppOAuthState,
  api = {
    exchangeCode: exchangeGitHubAppAuthorizationCode,
    getAuthorizedUser: getGitHubAppAuthorizedUser,
    getInstallation: getGitHubAppInstallation,
    getUserInstallation: getGitHubAppUserInstallation,
    getAuthorizationUrl: getGitHubAppAuthorizationUrl,
  },
  now = () => new Date(),
} = {}) => {
  const createState = async ({ userId, purpose, installationId }) => {
    const state = randomBytes(32).toString('base64url');
    await StateModel.create({
      stateHash: stateDigest(state),
      userId,
      purpose,
      ...(installationId ? { installationId } : {}),
      expiresAt: new Date(now().getTime() + STATE_LIFETIME_MS),
    });
    return state;
  };

  const consumeState = async (state) => {
    if (!isValidState(state)) return null;
    // findOneAndDelete makes each valid state single-use, including when callbacks race.
    return StateModel.findOneAndDelete({ stateHash: stateDigest(state) });
  };

  const startInstallation = async (req, res) => {
    try {
      const installUrl = parseInstallUrl();
      const state = await createState({ userId: req.user.userId, purpose: 'install' });
      installUrl.searchParams.set('state', state);
      // The dashboard must navigate the browser after an authenticated fetch
      // because the CodeGuard JWT is sent as a Bearer header. Keep the normal
      // redirect response for non-XHR callers.
      if (req.get?.('accept')?.includes('application/json')) {
        return res.status(200).json({ redirectUrl: installUrl.toString() });
      }
      return res.redirect(installUrl.toString());
    } catch {
      return res.status(503).json({ error: 'GitHub App installation is temporarily unavailable.' });
    }
  };

  const installationSetupReturn = async (req, res) => {
    let stateRecord;
    try {
      stateRecord = await consumeState(req.query.state);
    } catch {
      return res.redirect(dashboardResultUrl('error'));
    }

    if (!stateRecord || !isUnexpired(stateRecord, now()) || stateRecord.purpose !== 'install') {
      return res.redirect(dashboardResultUrl('invalid_state'));
    }

    if (req.query.setup_action === 'cancel') {
      return res.redirect(dashboardResultUrl('cancelled'));
    }

    if (!['install', 'update'].includes(req.query.setup_action)) {
      return res.redirect(dashboardResultUrl('error'));
    }

    try {
      const installation = await api.getInstallation(req.query.installation_id);
      const authorizationState = await createState({
        userId: stateRecord.userId,
        purpose: 'authorize',
        installationId: installation.id,
      });
      return res.redirect(api.getAuthorizationUrl(authorizationState));
    } catch {
      return res.redirect(dashboardResultUrl('verification_failed'));
    }
  };

  const authorizeInstallation = async (req, res) => {
    let stateRecord;
    try {
      stateRecord = await consumeState(req.query.state);
    } catch {
      return res.redirect(dashboardResultUrl('error'));
    }

    if (!stateRecord || !isUnexpired(stateRecord, now()) || stateRecord.purpose !== 'authorize') {
      return res.redirect(dashboardResultUrl('invalid_state'));
    }

    if (req.query.error === 'access_denied') {
      return res.redirect(dashboardResultUrl('cancelled'));
    }
    if (typeof req.query.code !== 'string' || !stateRecord.installationId) {
      return res.redirect(dashboardResultUrl('error'));
    }

    let stage = 'database_association';
    try {
      const user = await UserModel.findById(stateRecord.userId);
      if (!user) {
        logCallbackDiagnostic(stage, 'codeguard_user_missing');
        return res.redirect(dashboardResultUrl('account_mismatch'));
      }

      stage = 'authorization_code_exchange';
      const userAccessToken = await api.exchangeCode(req.query.code);

      stage = 'github_user_identity_verification';
      const authorizedGitHubUser = await api.getAuthorizedUser(userAccessToken);
      if (String(user.githubId) !== authorizedGitHubUser.id) {
        logCallbackDiagnostic(stage, 'identity_mismatch');
        return res.redirect(dashboardResultUrl('account_mismatch'));
      }

      stage = 'installation_verification';
      const [appInstallation, userInstallation] = await Promise.all([
        api.getInstallation(stateRecord.installationId),
        api.getUserInstallation(userAccessToken, stateRecord.installationId),
      ]);
      if (
        appInstallation.id !== stateRecord.installationId ||
        userInstallation.id !== stateRecord.installationId ||
        appInstallation.accountId !== userInstallation.accountId
      ) {
        logCallbackDiagnostic(stage, 'installation_mismatch');
        return res.redirect(dashboardResultUrl('verification_failed'));
      }

      stage = 'database_association';
      const identity = {
        installationId: stateRecord.installationId,
        userId: user._id,
      };
      const fields = installationFields(appInstallation);
      const existing = await InstallationModel.findOne({ installationId: identity.installationId });

      if (existing && !sameUser(existing.userId, identity.userId)) {
        logCallbackDiagnostic(stage, 'association_conflict');
        return res.redirect(dashboardResultUrl('already_connected'));
      }

      if (existing) {
        await InstallationModel.findOneAndUpdate(
          { installationId: identity.installationId, userId: identity.userId },
          { $set: fields },
          { new: true },
        );
      } else {
        try {
          await InstallationModel.create({ ...identity, ...fields });
        } catch (error) {
          if (error?.code !== 11000) throw error;
          const racedAssociation = await InstallationModel.findOne({
            installationId: identity.installationId,
          });
          if (!racedAssociation || !sameUser(racedAssociation.userId, identity.userId)) {
            return res.redirect(dashboardResultUrl('already_connected'));
          }
          await InstallationModel.findOneAndUpdate(
            { installationId: identity.installationId, userId: identity.userId },
            { $set: fields },
            { new: true },
          );
        }
      }

      return res.redirect(dashboardResultUrl('connected'));
    } catch (error) {
      logCallbackDiagnostic(stage, safeErrorCategory(error));
      return res.redirect(dashboardResultUrl('error'));
    }
  };

  return { startInstallation, installationSetupReturn, authorizeInstallation };
};

const controller = createGitHubAppController();
export const startGitHubAppInstallation = controller.startInstallation;
export const githubAppInstallationSetupReturn = controller.installationSetupReturn;
export const githubAppAuthorizationCallback = controller.authorizeInstallation;
