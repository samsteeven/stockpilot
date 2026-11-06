// Les sources importent en « .js » (convention ESM, client Prisma généré) : quand le .js n'existe pas, on tente le
// .ts. Les paquets npm, eux, sont résolus normalement.
module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options);
  } catch (error) {
    if (request.startsWith('.') && request.endsWith('.js')) {
      return options.defaultResolver(`${request.slice(0, -3)}.ts`, options);
    }
    throw error;
  }
};
