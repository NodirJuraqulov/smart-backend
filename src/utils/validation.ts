import { ApiError } from "@/utils/ApiError";

const MIN_PASSWORD_LENGTH = 6;
const MIN_LOGIN_LENGTH = 3;

const LOGIN_PATTERN = /^[a-zA-Z0-9_]+$/;

export function assertValidPassword(password: unknown): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(`Parol kamida ${MIN_PASSWORD_LENGTH} belgidan iborat bo'lishi kerak`, 400);
  }
}

export function assertValidLogin(login: unknown): void {
  if (
    typeof login !== "string" ||
    login.length < MIN_LOGIN_LENGTH ||
    !LOGIN_PATTERN.test(login)
  ) {
    throw new ApiError(
      `Login kamida ${MIN_LOGIN_LENGTH} belgidan iborat va faqat harf, raqam yoki pastki chiziqdan (_) tashkil topgan bo'lishi kerak`,
      400
    );
  }
}
