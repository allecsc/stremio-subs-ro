const manifest = {
  id: "org.stremio.subsro",
  version: "1.4.1",
  name: "Subs.ro Subtitles",
  description: "Romanian subtitles from Subs.ro (unofficial)",
  logo: "https://raw.githubusercontent.com/allecsc/stremio-subs-ro/refs/heads/master/public/logo.png",
  catalogs: [],
  resources: [
    {
      name: "subtitles",
      types: ["movie", "series"],
      idPrefixes: ["tt"],
    },
  ],
  types: ["subtitles"],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  stremioAddonsConfig: {
    issuer: "https://stremio-addons.net",
    signature:
      "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..q4j0ano6CbTfb68fykMYSA.MxmmYHIL4AyFI3Fqj6WqXIyBj3KDSp4APTMrEl5w0W7efxF1pnvfv6Cse-RSpR8vC_63IyjT8cDRYyt59k8sK0wLsFJVsobuPJqHfzW2hZvFB8OVI0v2FJ4SwibDRPU2.bPOOTlQmaqqWKjXFpSGAaw",
  },
};

module.exports = manifest;
