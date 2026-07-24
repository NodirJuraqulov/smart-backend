import rateLimit from "express-rate-limit";

export const generalApiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ message: "Juda ko'p so'rov, birozdan keyin urinib ko'ring" });
  },
});
