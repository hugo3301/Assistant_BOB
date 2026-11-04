// Scenario arithmetic, not a monthly usage guarantee. Rates checked 2026-11-05.
const values = { users: 10, calls: 20, voice: 5, input: 3000, output: 150 };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/u, "");
  if (
    !Object.hasOwn(values, key) ||
    !Number.isFinite(Number(process.argv[i + 1]))
  )
    throw Error("Use --users/--calls/--voice/--input/--output with numbers");
  values[key] = Number(process.argv[i + 1]);
}
if (
  Object.values(values).some((value) => value < 0) ||
  values.users < 1 ||
  values.users > 10 ||
  !Number.isInteger(values.users) ||
  values.input + values.output <= 0
)
  throw Error("Invalid scenario");
const models = {
  glm: [5500, 36400],
  granite: [1542, 10158],
  qwen: [4625, 30475],
};
const voiceNeurons = values.users * values.voice * 46.63;
console.log(
  JSON.stringify(
    {
      scenario: values,
      monthlyDays: 30,
      textTokensPerDay:
        values.users * values.calls * (values.input + values.output),
      textTokensPer30Days:
        30 * values.users * values.calls * (values.input + values.output),
      voiceMinutesPerDay: values.users * values.voice,
      cloudflare: Object.fromEntries(
        Object.entries(models).map(([name, [input, output]]) => {
          const perCall = (values.input * input + values.output * output) / 1e6;
          return [
            name,
            {
              neuronsPerCall: perCall,
              totalDailyNeurons:
                values.users * values.calls * perCall + voiceNeurons,
              maximumCallsPerPersonWithCurrentCap: Math.max(
                0,
                Math.floor((800 - values.voice * 46.63) / perCall),
              ),
              maximumCallsForGroupWithSharedCap: Math.max(
                0,
                Math.floor((9000 - voiceNeurons) / perCall),
              ),
            },
          ];
        }),
      ),
      groqPublishedFree: {
        textRequestsPerDay: Math.min(
          1000,
          Math.floor(200000 / (values.input + values.output)),
        ),
        audioMinutesPerDay: 28800 / 60,
        audioMinutesPerHour: 7200 / 60,
        accountNotVerified: true,
      },
      openRouterZeroPurchaseRequestsPerDay: 50,
      productionModelChanged: false,
    },
    null,
    2,
  ),
);
