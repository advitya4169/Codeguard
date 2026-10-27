import Installation from '../models/Installation.js';
import Repository from '../models/Repository.js';
import User from '../models/User.js';
import {
  getInstallationAccessToken,
  getInstallationRepositoriesPage,
} from '../services/githubAppService.js';

const normalizeInstallationId = (value) => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) {
    return null;
  }
  return value;
};

const normalizeRepositoryId = (value) => {
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) {
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

const isDuplicateKeyError = (error) => error?.code === 11000;

const repositoryResponse = (repository) => ({
  id: repository.id,
  name: repository.name,
  fullName: repository.fullName,
  private: repository.private,
  url: repository.url,
});

/** Dependency injection supports endpoint tests without live GitHub or MongoDB. */
export const createGitHubAppRepositoryController = ({
  InstallationModel = Installation,
  RepositoryModel = Repository,
  UserModel = User,
  api = {
    getInstallationAccessToken,
    getRepositoriesPage: getInstallationRepositoriesPage,
  },
} = {}) => {
  const listUserInstallations = async (req, res) => {
    try {
      const installations = await InstallationModel.find({ userId: req.user.userId })
        .select('installationId accountLogin accountName status')
        .sort({ createdAt: 1 })
        .lean();

      return res.status(200).json({
        installations: installations.map((installation) => ({
          installationId: installation.installationId,
          accountLogin: installation.accountLogin,
          ...(installation.accountName ? { accountName: installation.accountName } : {}),
          status: installation.status,
        })),
      });
    } catch {
      return res.status(500).json({ error: 'Could not load GitHub App installations.' });
    }
  };

  const getActiveInstallation = async (installationId, userId) => {
    const normalizedId = normalizeInstallationId(installationId);
    if (!normalizedId) return { error: 'invalid' };

    const installation = await InstallationModel.findOne({
      installationId: normalizedId,
      userId,
      status: 'active',
    });
    return installation ? { installation } : { error: 'not_found' };
  };

  const fetchInstallationRepository = async (token, repositoryId) => {
    let page = 1;
    while (true) {
      const result = await api.getRepositoriesPage(token, page);
      const repository = result.repositories.find((candidate) => candidate.id === repositoryId);
      if (repository) return repository;
      if (!result.pagination.hasNextPage) return null;
      page += 1;
    }
  };

  const listInstallationRepositories = async (req, res) => {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (!Number.isSafeInteger(page) || page < 1) {
      return res.status(400).json({ error: 'Page must be a positive integer' });
    }

    const installationId = normalizeInstallationId(req.params.installationId);
    if (!installationId) {
      return res.status(400).json({ error: 'A valid installationId is required' });
    }

    try {
      const result = await getActiveInstallation(installationId, req.user.userId);
      if (result.error) {
        return res.status(result.error === 'invalid' ? 400 : 404).json({
          error: result.error === 'invalid'
            ? 'A valid installationId is required'
            : 'Active GitHub App installation not found',
        });
      }

      const user = await UserModel.findById(req.user.userId).select('githubId').lean();
      if (!user?.githubId) {
        return res.status(404).json({ error: 'CodeGuard user not found' });
      }

      const tokenResult = await api.getInstallationAccessToken(installationId);
      const repositoryPage = await api.getRepositoriesPage(tokenResult.token, page);
      const connectedRepositories = await RepositoryModel.find({
        userId: req.user.userId,
        githubRepoId: { $in: repositoryPage.repositories.map((repository) => repository.id) },
        isConnected: true,
      }).select('githubRepoId installationId').lean();
      const connectionTypes = new Map(connectedRepositories.map((repository) => [
        repository.githubRepoId,
        {
          connectionType: repository.installationId ? 'github_app' : 'oauth',
          installationId: repository.installationId || undefined,
        },
      ]));
      return res.status(200).json({
        repositories: repositoryPage.repositories.map((repository) => ({
          ...repositoryResponse(repository),
          ownedByAuthenticatedUser: String(repository.ownerId) === String(user.githubId),
          connected: connectionTypes.has(repository.id),
          ...(connectionTypes.get(repository.id) || {}),
        })),
        pagination: repositoryPage.pagination,
      });
    } catch (error) {
      const status = error?.status === 503 ? 503 : 502;
      return res.status(status).json({
        error: status === 503
          ? 'GitHub is temporarily unavailable. Please retry repository discovery.'
          : 'Could not load repositories for this GitHub App installation.',
      });
    }
  };

  const connectInstallationRepository = async (req, res) => {
    const installationId = normalizeInstallationId(req.params.installationId);
    const repositoryId = normalizeRepositoryId(req.body?.repositoryId);
    if (!installationId || !repositoryId) {
      return res.status(400).json({ error: 'Valid installationId and repositoryId are required' });
    }

    try {
      const result = await getActiveInstallation(installationId, req.user.userId);
      if (result.error) {
        return res.status(result.error === 'invalid' ? 400 : 404).json({
          error: result.error === 'invalid'
            ? 'A valid installationId is required'
            : 'Active GitHub App installation not found',
        });
      }

      const tokenResult = await api.getInstallationAccessToken(installationId);
      const verified = await fetchInstallationRepository(tokenResult.token, repositoryId);
      if (!verified) {
        return res.status(403).json({ error: 'Repository is not accessible to this installation' });
      }

      const userId = req.user.userId;
      let repository = await RepositoryModel.findOne({ githubRepoId: verified.id });
      if (repository) {
        if (String(repository.userId) !== String(userId) || (
          repository.installationId && repository.installationId !== installationId
        )) {
          return res.status(409).json({
            error: 'Repository is already connected through another account or integration',
            code: 'REPOSITORY_OWNERSHIP_CONFLICT',
          });
        }

        repository.owner = verified.owner;
        repository.name = verified.name;
        repository.fullName = verified.fullName;
        repository.installationId = installationId;
        repository.isConnected = true;
        await repository.save();
      } else {
        try {
          repository = await RepositoryModel.create({
            githubRepoId: verified.id,
            owner: verified.owner,
            name: verified.name,
            fullName: verified.fullName,
            userId,
            installationId,
            isConnected: true,
          });
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
          repository = await RepositoryModel.findOne({ githubRepoId: verified.id });
          if (
            !repository ||
            String(repository.userId) !== String(userId) ||
            (repository.installationId && repository.installationId !== installationId)
          ) {
            return res.status(409).json({
              error: 'Repository is already connected through another account or integration',
              code: 'REPOSITORY_OWNERSHIP_CONFLICT',
            });
          }

          repository.owner = verified.owner;
          repository.name = verified.name;
          repository.fullName = verified.fullName;
          repository.installationId = installationId;
          repository.isConnected = true;
          await repository.save();
        }
      }

      return res.status(200).json({ repository: repositoryResponse(verified) });
    } catch (error) {
      const status = error?.status === 503 ? 503 : 502;
      return res.status(status).json({
        error: status === 503
          ? 'GitHub is temporarily unavailable. Please retry connecting the repository.'
          : 'Could not verify or connect this repository.',
      });
    }
  };

  return { listUserInstallations, listInstallationRepositories, connectInstallationRepository };
};

const controller = createGitHubAppRepositoryController();
export const listGitHubAppInstallations = controller.listUserInstallations;
export const listGitHubAppInstallationRepositories = controller.listInstallationRepositories;
export const connectGitHubAppInstallationRepository = controller.connectInstallationRepository;
