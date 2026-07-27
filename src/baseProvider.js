class BaseProvider {
  async chat(messages, options) {
    throw new Error('Method "chat" must be implemented');
  }

  async complete(prompt, options) {
    throw new Error('Method "complete" must be implemented');
  }
}

module.exports = BaseProvider;
