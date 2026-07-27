// This will eventually hold the mapping of provider names to implementations.

class ProviderFactory {
  constructor(config) {
    this.config = config;
    this.providers = {}; // Map of name -> instance
  }

  getProvider(name) {
    if (!this.providers[name]) {
      // Lazy load/instantiate providers
      // e.g., this.providers[name] = new OpenAIProvider(this.config.providers[name]);
      throw new Error(`Provider ${name} not implemented`);
    }
    return this.providers[name];
  }
}

module.exports = ProviderFactory;
