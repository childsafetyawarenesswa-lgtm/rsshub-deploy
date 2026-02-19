export default {
  async fetch(): Promise<Response> {
    return new Response("Worker is live", {
      headers: { "content-type": "text/plain" },
    });
  },
};
