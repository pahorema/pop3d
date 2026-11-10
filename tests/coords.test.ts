import { describe, expect, test } from "bun:test";
import { formatCoordinates, parseCoordinates } from "../src/geo/coords";

const near = (input: string, lat: number, lon: number) => {
  const result = parseCoordinates(input);
  expect(result).not.toBeNull();
  expect(result!.lat).toBeCloseTo(lat, 4);
  expect(result!.lon).toBeCloseTo(lon, 4);
};

describe("parseCoordinates", () => {
  test("decimal degrees", () => {
    near("45.6503, 13.7678", 45.6503, 13.7678);
    near("45.6503 13.7678", 45.6503, 13.7678);
    near("  -33.8568,151.2153 ", -33.8568, 151.2153);
    near("40.7484; -73.9857", 40.7484, -73.9857);
  });

  test("decimal commas, as written in much of Europe", () => {
    near("45,6503 13,7678", 45.6503, 13.7678);
    near("45,6503, 13,7678", 45.6503, 13.7678);
    near("45,6503; 13,7678", 45.6503, 13.7678);
  });

  test("hemisphere letters", () => {
    near("45.6503° N, 13.7678° E", 45.6503, 13.7678);
    near("N 45.6503 E 13.7678", 45.6503, 13.7678);
    near("33.8568 S 151.2153 E", -33.8568, 151.2153);
    near("13.7678E 45.6503N", 45.6503, 13.7678);
    near("40.7484 N 73.9857 O", 40.7484, -73.9857);
  });

  test("degrees, minutes and seconds", () => {
    near(`45°39'01.1"N 13°46'04.1"E`, 45.650306, 13.767806);
    near("45° 39' 1.1\" N, 13° 46' 4.1\" E", 45.650306, 13.767806);
    near("45°39.018'N 13°46.068'E", 45.6503, 13.7678);
    near("41°53′25″N 12°29′32″E", 41.890278, 12.492222);
  });

  test("labels, geo URIs and map links", () => {
    near("lat: 45.6503 lon: 13.7678", 45.6503, 13.7678);
    near("latitudine 45.6503, longitudine 13.7678", 45.6503, 13.7678);
    near("geo:45.6503,13.7678?z=17", 45.6503, 13.7678);
    near("https://www.google.com/maps/@45.6503,13.7678,17z", 45.6503, 13.7678);
    near("https://www.openstreetmap.org/#map=17/45.6503/13.7678", 45.6503, 13.7678);
    near("https://www.openstreetmap.org/?mlat=45.6503&mlon=13.7678", 45.6503, 13.7678);
  });

  test("rejects what is not a coordinate pair", () => {
    for (const input of [
      "",
      "Trieste",
      "34121",
      "Via Roma 12",
      "12, Via Roma",
      "95.0, 13.0",
      "45.0, 190.0",
      "1 2 3",
      "https://example.com/page",
      "10 Downing Street",
    ]) {
      expect(parseCoordinates(input)).toBeNull();
    }
  });
});

test("formatCoordinates", () => {
  expect(formatCoordinates({ lat: 45.6503, lon: 13.7678 })).toBe("45.6503° N  13.7678° E");
  expect(formatCoordinates({ lat: -33.8568, lon: -70.5 }, 2)).toBe("33.86° S  70.50° W");
});
