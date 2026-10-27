export const filterRepositories = (repositories, searchQuery) => {
  const query = searchQuery.trim().toLocaleLowerCase();
  if (!query) return repositories;

  return repositories.filter((repository) => (
    `${repository.name} ${repository.fullName}`.toLocaleLowerCase().includes(query)
  ));
};
