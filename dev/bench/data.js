window.BENCHMARK_DATA = {
  "lastUpdate": 1787492893396,
  "repoUrl": "https://github.com/scolladon/tsgit",
  "entries": {
    "tsgit benchmarks": [
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "325a53b41e328f5f406275ee576eaaf439801d23",
          "message": "feat: notes — git-faithful add/read/list/remove on refs/notes/* (#204)",
          "timestamp": "2026-06-29T15:13:15+02:00",
          "tree_id": "8bf9e13a3ee00af7a01ee98ef4886ff3ecc16252",
          "url": "https://github.com/scolladon/tsgit/commit/325a53b41e328f5f406275ee576eaaf439801d23"
        },
        "date": 1783008548250,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.09959200000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.55252749999977,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1594.8814589999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 902.2597365000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 18.440629000000058,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.181056499999954,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.670669999999973,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.46374699999978,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.36537799999996423,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 94.18402049999986,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6122004999999717,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.43561700000009296,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.32288900000003196,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3385370000000876,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7179.782471499999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2913.136057000025,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.285153500000206,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.416537000000062,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 14.714465500000188,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.530068000000028,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "eb253e9ef35ff60fa7d111863702888ebb98c4be",
          "message": "chore(main): release 3.0.0 (#119)",
          "timestamp": "2026-07-02T19:58:35+02:00",
          "tree_id": "b7873e152314b7dac5e059b104c60c85f7e20471",
          "url": "https://github.com/scolladon/tsgit/commit/eb253e9ef35ff60fa7d111863702888ebb98c4be"
        },
        "date": 1783016604065,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.302995999999894,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.04181299999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1725.8805270000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 949.7222769999971,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 19.874919999999975,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.756335000000036,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.764230999999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.90183100000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.42417150000005677,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.6970809999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5999979999999141,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4528889999999137,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3383899999998903,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.38282399999980044,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7835.848864500003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3134.759497000021,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.022527500000024,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.032378999999764,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.10012400000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.541697999999997,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "857039b7153f1434229ad9f9f48ccacdc59ce013",
          "message": "feat: SSH transport for clone, fetch, pull, and push (#207)",
          "timestamp": "2026-07-03T11:44:50+02:00",
          "tree_id": "86e49d40b92a0f47bacbf6f74f0049392b76c125",
          "url": "https://github.com/scolladon/tsgit/commit/857039b7153f1434229ad9f9f48ccacdc59ce013"
        },
        "date": 1783073433878,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 30.070412999999917,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.563625000000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1797.0242909999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 962.3422009999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.328525000000127,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.244061999999758,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.3143634999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 100.89593100000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.42219449999970493,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.90911400000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5924745000000939,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4082539999999426,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3564724999998816,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3674224999999751,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8147.139441000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3086.2969495001016,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.6575059999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.79384600000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.917275000000018,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.02115600000002,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "164b2e620ced7ce978b4945b8d847951ee1b8efa",
          "message": "feat: GPG signing — signed commits, tags, and pushes (#209)",
          "timestamp": "2026-07-04T00:06:26+02:00",
          "tree_id": "602cd8f9d4c263dc5117d47b339d1884fc77b716",
          "url": "https://github.com/scolladon/tsgit/commit/164b2e620ced7ce978b4945b8d847951ee1b8efa"
        },
        "date": 1783117893855,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.61536799999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.241895000000113,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1451.2527504999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 777.0151800000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.344720000000052,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.201627999999914,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.60513800000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 84.93237500000009,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3117019999999684,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 84.4309404999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.4994000000000369,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3685414999999921,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.28003000000012435,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.31648900000027425,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6700.4674620000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2580.0846305000596,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.704444500000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 6.957413000000088,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.231012499999906,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.51443399999971,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "0bb9e8835ac9e3b58ea442755d65e9c67d2cb8a5",
          "message": "feat: smart-HTTP protocol v2 for fetch and clone, with corrected v1 fallback (#210)",
          "timestamp": "2026-07-05T09:31:50+02:00",
          "tree_id": "4591d2d51ff0f360a954b4d81efe8f3704be0859",
          "url": "https://github.com/scolladon/tsgit/commit/0bb9e8835ac9e3b58ea442755d65e9c67d2cb8a5"
        },
        "date": 1783238236825,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.89751050000018,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.15968399999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1454.9259614999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 774.4062509999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.55093799999986,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.347937000000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.381469000000038,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 84.65483049999989,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.33151900000029855,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.57281449999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5308239999999387,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3504379999999401,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.25556699999992816,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.34059799999999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6811.477011999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2570.7747140000574,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.211169999999811,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.04891449999991,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.036665999999968,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.731039500000179,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sébastien Colladon",
            "username": "scolladon"
          },
          "committer": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sébastien Colladon",
            "username": "scolladon"
          },
          "distinct": true,
          "id": "1656f98fd742d7dba2cc365ef4563f5695d9ae15",
          "message": "docs: reorder Phase 26 backlog into execution sequence",
          "timestamp": "2026-07-05T23:01:14+02:00",
          "tree_id": "f7c1ce3d4cb1f7d2b342a0a6db034a19b2532f53",
          "url": "https://github.com/scolladon/tsgit/commit/1656f98fd742d7dba2cc365ef4563f5695d9ae15"
        },
        "date": 1783286834947,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.29101300000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.489497000000256,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1659.4892595000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 902.8206190000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.541187500000092,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.762114999999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.790656499999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.7119715,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.37978449999991426,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.13935500000025,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5302675000000363,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.39253899999994246,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.29235000000016953,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3459509999997863,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7366.217122000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2979.956292000017,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.910802999999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.643263999999817,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 14.597089000000096,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.647690999999895,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "69dabf51cc2396c9d815b021fb82705c7b168871",
          "message": "refactor: centralize magic literals into named constants (#211)",
          "timestamp": "2026-07-06T09:47:26+02:00",
          "tree_id": "e2bca1e8d244e75e8e0cdc04c8882bc988520a97",
          "url": "https://github.com/scolladon/tsgit/commit/69dabf51cc2396c9d815b021fb82705c7b168871"
        },
        "date": 1783325481325,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 42.15275699999984,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 49.77532250000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1190.313302999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 610.5385435000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.565268999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.631575999999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.858181000000059,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 64.1488865,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.25343100000009144,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 67.70911649999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3753554999999551,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.2756960000001527,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.2035519999999451,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.22976649999986876,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5421.967176999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2047.7368060001172,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.048128999999903,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 5.272261999999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.441587000000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.990070499999774,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "f73f9a100a93d0a00a285b9ebc5899e175db3f3e",
          "message": "feat: git-faithful branch/remote and push.default resolution (#215)",
          "timestamp": "2026-07-07T09:12:11+02:00",
          "tree_id": "4910452fad5cdfda4b8f7f24cfb6f87b78f371fb",
          "url": "https://github.com/scolladon/tsgit/commit/f73f9a100a93d0a00a285b9ebc5899e175db3f3e"
        },
        "date": 1783409866889,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.274282500000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.459716999999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1440.7849590000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 782.274998500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.542378499999927,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.246268999999756,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.375525000000152,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.95912850000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.32033599999977014,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 82.78550099999961,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5065640000000258,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.34195899999997437,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.25385800000003655,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.29795850000004975,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6651.849907499996,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2551.1052990001626,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.691877499999919,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 6.632134499999893,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.833270999999968,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.393597000000227,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "7a1dd5d493a3607ef3778a116a93d607aa618156",
          "message": "feat: zero-dependency inflate decoder for browser/memory large-entry pack clone (#216)",
          "timestamp": "2026-07-07T17:31:46+02:00",
          "tree_id": "08681398f4454df9e1bb999fdfd37651aa3f7345",
          "url": "https://github.com/scolladon/tsgit/commit/7a1dd5d493a3607ef3778a116a93d607aa618156"
        },
        "date": 1783439847184,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.322959000000083,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.320606000000225,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1753.6681500000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 965.5691689999967,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.28833499999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.568041999999878,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.07088349999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.13374249999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.39766400000007707,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.11791700000049,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5483159999998861,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4549765000001571,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3427209999999832,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.40505800000005365,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8008.636555500005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3123.5183709999546,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.242886,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.389289999999619,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.15214500000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.093461000000389,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "c83b9326ebd3fdfb2637bee62b34375a725f82d1",
          "message": "docs: spike streaming streamInflate output cap (#217)",
          "timestamp": "2026-07-07T23:38:02+02:00",
          "tree_id": "7c7ddb3de19568f51674ad8be4a162bdd5448be4",
          "url": "https://github.com/scolladon/tsgit/commit/c83b9326ebd3fdfb2637bee62b34375a725f82d1"
        },
        "date": 1783461836866,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.174343000000135,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.29205950000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1678.944772499999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 911.5363350000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.298334999999952,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.401116499999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.141761999999972,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.34340250000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3969094999999925,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.20548600000029,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5315630000000056,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4048539999998866,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.36166300000013507,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4164304999999331,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7546.699162499997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3296.3344459999353,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.961493000000019,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.022001000000046,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.115614000000278,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.10607449999975,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "b10ac0f725297e6158f6e17450b2a2e446f24270",
          "message": "docs: drop stale workers-types filter note from manifest (#218)",
          "timestamp": "2026-07-08T19:04:25+02:00",
          "tree_id": "400b063557810a0fb8de617ef0b1292616baf20c",
          "url": "https://github.com/scolladon/tsgit/commit/b10ac0f725297e6158f6e17450b2a2e446f24270"
        },
        "date": 1783531870241,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.395217499999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.36812800000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1740.1186779999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 957.5200594999988,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 21.91061949999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.676840500000253,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.033415000000105,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.78709650000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3804939999999988,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.35094850000019,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.601291999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3757894999999962,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.35324199999968187,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3764059999998608,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8107.8813095000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3188.554305999889,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.171231999999918,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.181072999999742,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.56600599999979,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.19520999999986,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "732005096439b36ae3449776feb5c92a6f053d05",
          "message": "perf: describe early-termination traversal breaks (#219)",
          "timestamp": "2026-07-09T19:47:28+02:00",
          "tree_id": "ba2b7f4ae6372a9bf33ce5205a0c0c0aeeba0789",
          "url": "https://github.com/scolladon/tsgit/commit/732005096439b36ae3449776feb5c92a6f053d05"
        },
        "date": 1783620677341,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.558487499999956,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 39.398983000000044,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 4.839634500000045,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1103.1923235000004,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 618.6766674999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.10098599999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.062677000000122,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.118800999999962,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.66420700000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.22956999999996697,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.8948155000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.40396099999998114,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.25573449999990316,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.20616549999976996,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.24927699999989272,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6067.305302500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2417.0865540000377,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.464371000000028,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 6.246236999999837,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.421185500000092,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.395064000000275,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "5af3f455c2821e235149a749ffe6cd866e9e7316",
          "message": "perf: prune name-rev walk at the target date cutoff (#220)",
          "timestamp": "2026-07-09T21:25:32+02:00",
          "tree_id": "864be0622f811874306b9d56f297611a7faad87e",
          "url": "https://github.com/scolladon/tsgit/commit/5af3f455c2821e235149a749ffe6cd866e9e7316"
        },
        "date": 1783626724240,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.12464200000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.264506499999925,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.349204500000042,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1763.9948949999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 961.3803404999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.03063700000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.231707000000142,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.7758284999999887,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.679458000000068,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 100.39199150000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3640720000003057,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.79284349999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5719609999998738,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4240439999998671,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3224645000000237,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3577700000000732,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8235.3115985,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3324.5810094999615,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 18.778802999999925,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.609230999999909,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.346947,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.499330500000042,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "43830781172b67c7d236d9fd75dc14a9dd894a3e",
          "message": "perf: migrate the commit priority-queue to an O(N log N) binary heap (#221)",
          "timestamp": "2026-07-10T09:20:19+02:00",
          "tree_id": "e0ae2abdb47110f93b256641041a13954b4b7564",
          "url": "https://github.com/scolladon/tsgit/commit/43830781172b67c7d236d9fd75dc14a9dd894a3e"
        },
        "date": 1783669578251,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.564744000000246,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.231930499999862,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.20085000000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1792.067652499999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 956.8660605000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.644178999999895,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.859231000000364,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.685766000000058,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.573722999999973,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.15825200000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.39152100000001155,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.33460950000017,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6912720000000263,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.41898300000002564,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3308234999999513,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.42124699999976656,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7989.658066999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3422.537743999972,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.074589999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.44623700000011,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.96225800000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.316294000000198,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "fc0105ff0bed1343f5ae7104ceb967763636bf35",
          "message": "perf: stop shipping source maps to shrink the npm tarball ~2× (#222)",
          "timestamp": "2026-07-10T11:15:20+02:00",
          "tree_id": "d3d7cdd097fda30ce2c131e9a42e4c2257a5dee0",
          "url": "https://github.com/scolladon/tsgit/commit/fc0105ff0bed1343f5ae7104ceb967763636bf35"
        },
        "date": 1783676491099,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.951902000000246,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.263492499999984,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.880758999999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1814.5562354999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 944.1631369999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.987138500000015,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.138344999999845,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.925590999999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.048005999999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.4461859999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.37649099999998725,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.43396200000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.609335000000101,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4425745000000916,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.32655800000020463,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4139709999999468,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8139.436511,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3130.3074730000226,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.540230000000065,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.288460000000214,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.31499800000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.248450999999932,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "7ad7d4fabce0d3e8d22cf4de73260248d6eb953d",
          "message": "test(bench): add memory-pressure scenarios (large packs, deep delta chains) (#223)",
          "timestamp": "2026-07-10T16:51:52+02:00",
          "tree_id": "7529a0436503832015dc439704143d47423bc924",
          "url": "https://github.com/scolladon/tsgit/commit/7ad7d4fabce0d3e8d22cf4de73260248d6eb953d"
        },
        "date": 1783695652995,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.47195399999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 29.07001000000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.054581999999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6273959999998624,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.131901999999855,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6573100000000522,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.680025,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1740.0652309999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 934.7186785000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 19.7552905,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.10456000000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.686202499999979,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.070421000000351,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 91.72905150000042,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.4130929999992077,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.78485099999943,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5565010000000257,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.41532200000006014,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3426209999997809,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4259669999999005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7912.9562425,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3223.193365500003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.441269499999976,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.966781999999967,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.838624999999865,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.295768499999895,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "6f52886f05c610e59bc7986cf67567ea2271e996",
          "message": "chore(profile): per-command profile capture and committed baseline (#224)",
          "timestamp": "2026-07-11T16:12:38+02:00",
          "tree_id": "93638e611207099dae00b182027ac452ad28eb30",
          "url": "https://github.com/scolladon/tsgit/commit/6f52886f05c610e59bc7986cf67567ea2271e996"
        },
        "date": 1783780660231,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.06553299999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.388000499999862,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.499586000000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.693277500000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.803598000000193,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5999680000002172,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.163614999999936,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1681.498321,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 939.8401555,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.79095099999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.274618499999974,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.871629000000041,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.882119500000272,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 91.77799700000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3609835000002022,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.6235059999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5546360000000732,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.42414199999984703,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3587400000001253,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.37835699999959616,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7826.860412000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3424.056595500093,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.061425999999983,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.9545949999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.746456500000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.894084999999905,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "5820c789438f667a648e842e9f299e2e9af4046b",
          "message": "perf: optimise the node fs containment hot path (await-gate, closure hoist, lstat parent cache) (#225)",
          "timestamp": "2026-07-12T23:37:24+02:00",
          "tree_id": "35b9dd43f9c2e49c97dc168ec79ad0f9fb3bb0e6",
          "url": "https://github.com/scolladon/tsgit/commit/5820c789438f667a648e842e9f299e2e9af4046b"
        },
        "date": 1783893680907,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.217044499999986,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.138225999999804,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.960121999999956,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.8018475000001217,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.981276999999864,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6027579999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.22245799999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1616.0949085000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 894.5029235000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.745751499999983,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.72354949999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 5.161870000000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.820053000000144,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.00923349999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3831190000000788,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.06964899999957,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6040140000000065,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3944300000000567,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.2952139999999872,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.34363500000017666,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5482.714292000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2897.6945054999087,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.112535500000035,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.671310000000176,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.222474499999862,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.176723000000038,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "50d3a08827a712c7ce28d81190c0fe3590d4c1c2",
          "message": "perf(blame): TREESAME skip + O(path-depth) tree descent (#229)",
          "timestamp": "2026-07-13T13:55:09+02:00",
          "tree_id": "9462fa61c5fc446e8b05bd7f6bc595b9d8644204",
          "url": "https://github.com/scolladon/tsgit/commit/50d3a08827a712c7ce28d81190c0fe3590d4c1c2"
        },
        "date": 1783945154710,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 204.95311649999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.705005999999912,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.576393499999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.92438500000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.7341400000000249,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.933352500000069,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6670389999999315,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.925039999999967,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1692.1038344999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 933.2031605000011,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 18.307497000000012,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.44540599999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.992252000000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.078906000000188,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.2259389999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.40103850000014063,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.06262199999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5689424999999346,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.38185999999996056,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3096134999998412,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.39568099999996775,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5838.032818000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3034.8153119999915,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.07943899999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.902417000000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.882988000000296,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.732005500000014,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "f5829c96d90bf2cb2d5bddbeb2b6fce1c5935d50",
          "message": "docs: publish honest competitor benchmark comparison vs isomorphic-git (#230)",
          "timestamp": "2026-07-13T16:01:42+02:00",
          "tree_id": "9fa2d654bbadb9bd4feb1e4e1fe08028f35dcb35",
          "url": "https://github.com/scolladon/tsgit/commit/f5829c96d90bf2cb2d5bddbeb2b6fce1c5935d50"
        },
        "date": 1783952805729,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 160.58275099999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 30.403984000000037,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.547478999999953,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.143350499999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5767430000000786,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.03476099999989,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5536940000001778,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 7.325627999999938,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1449.7327190000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 789.4188669999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.79306500000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.581448999999907,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.165009999999938,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.472492499999817,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.98045950000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3374080000003232,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 82.6065209999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.4815150000001722,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.354153999999653,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.24435300000004645,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.34444799999982934,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5054.028534999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2546.882268999936,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.337332999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.089922999999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.448203999999805,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.762842999999975,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "35ea4eca331a1956390fceec8d6f4ddabb6c7c1a",
          "message": "perf(node-fs): amortise the status:clean containment tax (#231)",
          "timestamp": "2026-07-13T21:55:35+02:00",
          "tree_id": "7d017ba030ceba38dc91882efa234cdd7f5aca82",
          "url": "https://github.com/scolladon/tsgit/commit/35ea4eca331a1956390fceec8d6f4ddabb6c7c1a"
        },
        "date": 1783974006741,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 188.46997350000015,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.080422,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 29.413688999999977,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.657709999999952,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6204930000000104,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.787948500000084,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6917069999999512,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.25026600000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1642.9746145,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 932.3566795000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 18.074303999999984,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.582889000000023,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.538101499999925,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.315517999999884,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.02606850000029,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3590439999998125,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.7491659999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5701999999998861,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.40414899999996123,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.31393949999983306,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.36188499999980195,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5913.568133500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3080.650578500121,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.803434000000038,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.954004999999597,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.042198999999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.681153500000164,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "8973596c281f7b0f34e88d56589d00f9e7d25021",
          "message": "ci(bench): advisory same-runner benchmark regression gate (#232)",
          "timestamp": "2026-07-14T11:03:54+02:00",
          "tree_id": "8b5d3216e64f9f6ebef8a7e690df8ffa09ca194c",
          "url": "https://github.com/scolladon/tsgit/commit/8973596c281f7b0f34e88d56589d00f9e7d25021"
        },
        "date": 1784021292691,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 188.02973550000024,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.804936499999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.091149000000087,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.330330499999945,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5692590000001019,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.971476999999823,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5978720000002795,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.29188099999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1689.825798500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 927.2937695000019,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 19.760796000000028,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.346002999999882,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.815226000000052,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.971695500000124,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.27325149999979,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.42564700000048106,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.26234449999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6466810000000578,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.38840699999991557,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.311337500000036,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.37330900000006295,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5899.2915655,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3124.366098999977,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.01156299999991,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.022009999999682,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.03097200000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.650285000000167,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "785d59f8755161e4958704e207a059dd1e0f2979",
          "message": "test(mutation): complete whole-codebase mutation sweep + accumulated hardening (#241)",
          "timestamp": "2026-07-22T18:49:00+02:00",
          "tree_id": "2c9dfc0aa0cf42468dc25f99ff92524c5eb4495a",
          "url": "https://github.com/scolladon/tsgit/commit/785d59f8755161e4958704e207a059dd1e0f2979"
        },
        "date": 1784740568048,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 164.43800450000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.178217999999788,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.71759099999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.71167400000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5019210000000385,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.644514999999956,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5806550000002062,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 7.89917650000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1454.868445,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 799.1498439999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.050026000000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.865179999999782,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.672706000000062,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.566455000000133,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 86.12693150000018,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.32549999999991996,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 84.89771799999971,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5252809999999499,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3487404999999626,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.2509979999999814,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3273530000001301,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5330.070508500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1972.2451000000583,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.103870000000029,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 5.8151540000001205,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.475167000000056,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.817641999999978,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "e1d52083d49fd5cbef32fbcde530ddb027535ef7",
          "message": "fix(repository): drive-letter and UNC aware commonAncestor for worktree fs (#242)",
          "timestamp": "2026-07-23T09:36:37+02:00",
          "tree_id": "831751d290381141d5fee53a33ccb07a11c8f654",
          "url": "https://github.com/scolladon/tsgit/commit/e1d52083d49fd5cbef32fbcde530ddb027535ef7"
        },
        "date": 1784793677079,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 198.85832999999957,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 30.592020000000048,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 33.30672900000036,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 14.030046500000083,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.673520999999937,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.122732999999698,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.7376519999997981,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.325149500000009,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1765.1819479999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 954.8824134999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 19.8527610000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.364593000000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.923036999999965,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.30071399999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.44901400000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.4113800000000083,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.99548950000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6223849999998947,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4022829999998976,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3323209999998653,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.42060700000001816,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6029.051640999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2326.018836000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.460775999999896,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.509270999999899,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.573259500000177,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.540656000000126,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "01174e170a5ec38316b5e05ab89733fcbfc59135",
          "message": "fix(merge): user-configured driver overrides the same-named built-in (#243)",
          "timestamp": "2026-07-23T14:00:26+02:00",
          "tree_id": "e84f9ef49512b030843fee5639c4bbcfe67d2e55",
          "url": "https://github.com/scolladon/tsgit/commit/01174e170a5ec38316b5e05ab89733fcbfc59135"
        },
        "date": 1784809412167,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 138.1314064999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 22.582171500000015,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 23.981127000000015,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.741913000000068,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5539459999998826,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.06490000000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5442440000001625,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 6.05651899999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1147.5497054999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 636.7788134999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.740482499999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.001694000000043,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.5587399999999434,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.60051199999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 93.34277900000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.23957800000016505,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 90.99491999999964,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.41692699999998695,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.28547549999996136,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.22666700000013407,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.2532889999999952,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4749.269389000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1871.1782165000332,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.777768000000037,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 5.338792000000012,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.357193000000052,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.565405000000283,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "a1caf6c3d47d13ea41f022418ab7a1cdf5f7cfaa",
          "message": "test(unit): minimise the unit test suite preserving GWT discipline (#244)",
          "timestamp": "2026-07-24T12:33:10+02:00",
          "tree_id": "30356c9ac0dccbe343f03cddd466b66f71120333",
          "url": "https://github.com/scolladon/tsgit/commit/a1caf6c3d47d13ea41f022418ab7a1cdf5f7cfaa"
        },
        "date": 1784890715149,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 156.0406065000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.931493499999988,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.3716629999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.487154000000032,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5726069999998344,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.207929499999864,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.577694000000065,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 7.481324500000028,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1430.706255,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 780.2711490000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.538831000000073,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.7497075,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.215897000000041,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.57314099999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 91.45470849999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.34471650000023146,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 86.6885310000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.512407999999823,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3360689999999522,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.24593899999990754,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.30446600000004764,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5280.190352000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1938.6455219998024,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.384458999999879,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 5.846459999999752,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.562727999999879,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.536802500000022,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "5fb0c9c150aeda8bfe933c5b28dcd3f402cecd5f",
          "message": "test(integration): minimise the integration test suite by collapsing scenario overlap (#245)",
          "timestamp": "2026-07-24T18:58:11+02:00",
          "tree_id": "fd1fa76fc96afd2e6881e4c4d6dff302195dfaf4",
          "url": "https://github.com/scolladon/tsgit/commit/5fb0c9c150aeda8bfe933c5b28dcd3f402cecd5f"
        },
        "date": 1784913742021,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 118.4971415,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.547713000000044,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 22.226932000000033,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.308328000000074,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2055050000000165,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5.939637000000062,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1963610000000244,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 5.7976770000000215,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1105.3590520000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 611.8588180000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.140740999999935,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.766096500000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.1846340000000737,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.624712000000045,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 67.9247835000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.24182400000017878,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 66.75680000000011,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.41907100000003084,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.2597610000000259,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.18661000000020067,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.22001099999988583,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3941.773305499999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1544.6394304999849,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.91354100000035,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 4.411439999999857,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.2588009999999485,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.918889999999919,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "9d84ccc06b3942ae1c507f0038b87abc9b9717f2",
          "message": "docs: audit the e2e test tier and confirm it is already minimal (#246)",
          "timestamp": "2026-07-24T22:40:32+02:00",
          "tree_id": "5d74d8e7663b1b4d329bdb37c37d1449d605110a",
          "url": "https://github.com/scolladon/tsgit/commit/9d84ccc06b3942ae1c507f0038b87abc9b9717f2"
        },
        "date": 1784927181441,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 117.48824850000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.832438000000025,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 17.840339000000085,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6.822975000000042,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.195538000000056,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5.709319999999934,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1805810000000747,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 4.814279000000056,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 936.6545845000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 521.7127720000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.130145000000084,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.239478999999847,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.7237040000001116,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.958425999999918,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.89985850000016,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.2672019999999975,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 90.11380600000075,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.35672500000009677,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.22909500000014305,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.19257100000004357,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.21901300000035917,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3940.2398564999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1512.1739784999518,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.438073499999973,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 4.030921999999919,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.336755499999981,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.652399500000001,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "d39190e239a7a25970566d1065ed7c9b89e1cf13",
          "message": "test(bench): rebuild the bench suite around hot paths (#247)",
          "timestamp": "2026-07-25T10:44:08+02:00",
          "tree_id": "46cb93488d11ed2eec893a2ef877935b9f2a2589",
          "url": "https://github.com/scolladon/tsgit/commit/d39190e239a7a25970566d1065ed7c9b89e1cf13"
        },
        "date": 1784969565018,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 7.6606669999999895,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 52.446436500000004,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 425.59379400000034,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.4217800000000125,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.81477499999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 29.060471000000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 12.17941099999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.79052200000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.58869199999981,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.316971000000194,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.511275500000238,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.06289750000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 7.284851000000117,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 10.210734000000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 18.456913999999983,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.108811999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1453.3199630000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 777.044549000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5007949999999255,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3517259999998714,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 54.93882649999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.0788305000000378,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.9159910000000764,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.184948500000246,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2220330000000104,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.61563699999897,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 78.13032249999924,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3270750000001499,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.179061000000729,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.2938914999995177,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 82.17702149999968,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.6081379999999967,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 373.3230344999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.551699999999983,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.187904000000117,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 58.27219249999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 20.930649500000072,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5168.15423,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2022.6511539999992,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "c9aae7f9fdacc10f8229501c78d9922840fde7e3",
          "message": "test: conform all test tiers to sut/result + AAA + GWT conventions and gate them (#248)",
          "timestamp": "2026-07-26T00:16:23+02:00",
          "tree_id": "81defa5c176c39f771539d57032d06fd4a351d3d",
          "url": "https://github.com/scolladon/tsgit/commit/c9aae7f9fdacc10f8229501c78d9922840fde7e3"
        },
        "date": 1785019232952,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 9.190889000000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 60.524076000000036,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 493.4844045,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.4855190000000107,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.72040000000004,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.820009000000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 13.842041999999935,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.275510999999938,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.7151919999998881,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.021027000000004,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6564530000002833,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.478232999999989,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 7.7738555000000815,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 12.047015000000101,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 21.463200000000143,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.486787499999991,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1675.1027974999988,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 939.7089199999973,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6120194999998603,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.41888950000020486,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 62.50886900000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 5.4007930000000215,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.863001499999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.550213999999869,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.204660499999818,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.70202399999971,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.61188549999952,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.34669599999961065,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6160680000002685,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3430179999995744,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 94.36531250000098,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.7163340000000744,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 416.19644949999974,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.919250999999804,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.966468000000077,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 71.195017,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 23.18529800000033,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5926.7538265,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2302.9091654999647,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "61d0ed721b89149c5265aaaab6eb3bf3977b6523",
          "message": "docs: root-cause the stryker vitest-4 phantom survivors and harden mutation triage (#249)",
          "timestamp": "2026-07-26T18:58:48+02:00",
          "tree_id": "d4bebb300d10ed2caa0f110ceadd91bc188709db",
          "url": "https://github.com/scolladon/tsgit/commit/61d0ed721b89149c5265aaaab6eb3bf3977b6523"
        },
        "date": 1785086527630,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 5.887435499999981,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 38.858784000000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 318.32459949999975,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.3088070000000016,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 21.970829999999978,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 24.279175000000123,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 8.815285499999959,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.713680499999953,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.249264999999923,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6.1213299999999435,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2081239999997706,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 5.384186999999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 5.240020000000072,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 7.447170000000028,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 14.454457500000046,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.242593999999826,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1113.5962015000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 610.9226129999988,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3942930000000615,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.2519090000000688,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 41.780147,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.1992329999999924,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.1299690000000737,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.934244999999919,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.959512999999788,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.651041999999961,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 64.90042500000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.2494459999998071,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.9119220000002315,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.2034359999993285,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 67.89340949999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.42059600000004593,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 287.3058014999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.128033000000187,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.86405400000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 44.30254300000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.32000949999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4134.057154500002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1578.3119169999845,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "185a8a8561196a3befcd9efce6e4d63fa709ca85",
          "message": "chore(main): release 3.1.0 (#208)",
          "timestamp": "2026-07-26T19:55:26+02:00",
          "tree_id": "98a16f7efe4ab57d40f10738c2c22666d44985c8",
          "url": "https://github.com/scolladon/tsgit/commit/185a8a8561196a3befcd9efce6e4d63fa709ca85"
        },
        "date": 1785089990285,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 9.461807000000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 64.12528799999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 517.2541544999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.5385394999999562,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 28.431033000000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.885932499999967,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 14.410427000000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.86903099999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6527355000000625,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.853072999999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.7538389999999708,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.526660000000106,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.315402000000063,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 12.053318000000104,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 21.328501999999958,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.631266000000096,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1731.4655455000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 948.4021859999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6729655000000321,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.42635500000005777,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 65.70872849999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 5.735702999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.570570999999973,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.3891704999998638,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.3568295000002308,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.59988999999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 92.95831599999974,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.38019350000058694,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2756379999991623,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.395766999999978,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.9377099999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.7822025000000394,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 427.4916505000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 14.212447999999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.849044999999819,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 69.07407200000011,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 25.247564499999953,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5997.750406500003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2313.7841905000387,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "5b0213977dfac101fe88dd7d39588ce3a015d57a",
          "message": "perf: close the isomorphic-git gap and land the sfdx-git-delta spike findings (#253)",
          "timestamp": "2026-07-27T22:11:16+02:00",
          "tree_id": "3fdfb0698fca09ee38dc35b71c5aeba04da0b7ac",
          "url": "https://github.com/scolladon/tsgit/commit/5b0213977dfac101fe88dd7d39588ce3a015d57a"
        },
        "date": 1785183484641,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 7.401331000000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.4928749999999127,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 9.846792499999879,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.07281250000005457,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.637518499999942,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.97970999999984,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 11.413076000000046,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.520854999999983,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5335250000000542,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005368000000089523,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.4601059999999961,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.6299040000000105,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.629524000000174,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.5631490000000667,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 1.5971090000000459,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.498634000000095,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.0620435000000725,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.214286499999616,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 43.538948500000515,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 745.9410449999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 43.97431199999846,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5700920000001588,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.31367299999988063,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 52.996110499999986,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.300202000000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.228211000000101,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.1808239999991201,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2010434999992867,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.783382000000529,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 76.8173014999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004256000000168569,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.112387499999386,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004315999998652842,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 76.73825750000015,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.5412644999999543,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.9511150000000725,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.387667000000079,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.039393000000018,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.434983000000102,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 19.69581900000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1596.5386204999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1872.8321929999984,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "d5acff3dc83bbe49f9042b771cbaaad7a62d04bd",
          "message": "chore(main): release 3.1.1 (#254)",
          "timestamp": "2026-07-27T22:22:35+02:00",
          "tree_id": "b47fa5dab5effdc9ce3fd3dfada3ee6a289a631b",
          "url": "https://github.com/scolladon/tsgit/commit/d5acff3dc83bbe49f9042b771cbaaad7a62d04bd"
        },
        "date": 1785185169594,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 7.698126000000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.5736154999999599,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 10.037975000000074,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.07461000000000695,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.52130599999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.741605000000163,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 11.784265000000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.684182999999962,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.4478090000000066,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005287999999836757,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.494921000000204,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.7899770000000217,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.6608249999999316,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.687844000000041,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 1.5564999999999714,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.541266999999948,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.0507330000000366,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.48377000000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 45.00300500000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 754.2155214999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 44.334397499999795,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5693409999998948,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3564559999999801,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 55.031168500000035,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.744585999999913,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.5998959999998306,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.217444000000114,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2076644999999644,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.045638999999937,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 77.79342799999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004305999999814958,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.219822000000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004355999999461346,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 77.24840849999964,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.5329269999999724,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 1.0424049999999738,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.59781299999986,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.204355000000078,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 43.300196500000084,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 19.63317600000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4791.069654999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1900.0295199999819,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "9e128c046f394ea8f016c0225341a1d5832721a5",
          "message": "chore(main): release 3.1.2 (#256)",
          "timestamp": "2026-07-28T20:11:01+02:00",
          "tree_id": "00ad37140183276ef844c300e53e4a2582f2afdd",
          "url": "https://github.com/scolladon/tsgit/commit/9e128c046f394ea8f016c0225341a1d5832721a5"
        },
        "date": 1785263735106,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 7.74193200000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.564799999999991,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 10.46468300000015,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.07688099999995757,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.432146999999986,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.48459400000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 11.937624500000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.845248999999967,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.4929319999999962,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005598999999619991,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5541890000001786,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.9214660000000094,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.6231410000000324,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.4511049999998704,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.3348449999998593,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 0.9519815000001017,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 28.373117499999353,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.3484644999998636,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 12.525961999999708,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 1.420616999999936,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.5918709999999692,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.1022719999999708,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.866211000000021,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 46.743202999999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 755.6452464999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 46.63234799999918,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5557179999999562,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3568279999999504,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 55.539888500000075,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.243200999999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.8631735000000162,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.2687140000000454,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2388700000001336,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.779806999999892,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 77.43384399999968,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004527000000052794,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1522575000003599,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004557000000204425,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 77.62013499999966,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.6143260000000055,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.8344679999999016,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.636606999999913,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.152190000000246,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 44.85331499999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 20.661801999999852,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4782.5018820000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1944.8227399998577,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "70ae1ee5e5b5911d6ef818ad2e599ef2ef83e0b6",
          "message": "feat: ship a single-file no-build browser bundle (#257)",
          "timestamp": "2026-07-29T09:21:05+02:00",
          "tree_id": "7819ff0928f1f43b1a8becd59d275f962874799f",
          "url": "https://github.com/scolladon/tsgit/commit/70ae1ee5e5b5911d6ef818ad2e599ef2ef83e0b6"
        },
        "date": 1785311460598,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 9.316807500000039,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.9547890000000052,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 11.113863000000038,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.10446600000000217,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 32.16044550000004,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.626277000000073,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 14.407637000000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5.1667790000000196,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.7024125000000367,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005169999999907304,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6270360000003166,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 3.478392500000041,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 3.2346370000000206,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.9156240000002072,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.5961649999999281,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 1.0776590000000397,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 31.154427999999825,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 2.0244425000000774,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 13.875930000000153,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 1.696589500000016,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.9301470000000336,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.439292999999907,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.20878700000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 49.32998499999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 951.1662760000017,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 48.9345229999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.659819500000026,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.443559999999934,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 63.659861500000034,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.57185800000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.4563610000000153,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.4820499999999583,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2366849999998522,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.353550000000041,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 90.92769650000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004358000000138418,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.288431999999375,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.0044280000001890585,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 90.27484400000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.6781065000000126,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 1.110922999999957,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.981119000000035,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.034498999999869,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 56.57533349999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 24.024040000000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5611.7479055,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2310.840984999959,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "3e909914d76e8387aaaad31824e9606677ee6308",
          "message": "fix: open repositories through .git gitfile pointers (linked worktrees, submodules, separate git dirs) (#259)",
          "timestamp": "2026-07-30T16:38:39+02:00",
          "tree_id": "05f9922422e103237aa2beeb0eda550e79a74a4d",
          "url": "https://github.com/scolladon/tsgit/commit/3e909914d76e8387aaaad31824e9606677ee6308"
        },
        "date": 1785423777609,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 9.49342999999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.9124744999999734,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 11.682998500000053,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.10904299999992872,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 28.830033999999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.363744999999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 14.451697999999965,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5.446870999999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6316690000001017,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005209999999806314,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.620738000000074,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 3.716372500000034,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.966083000000026,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.6653759999999238,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.5366104999998242,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 1.135443000000123,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 30.47825399999965,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.9243545000003905,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 14.351946999999655,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 1.7063630000000103,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.803854999999885,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.3447529999999688,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.174418500000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 50.02454849999981,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 945.7036275,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 49.17715450000105,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.0260339999999815,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4128604999998515,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 65.80531900000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.7499149999999872,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.5934045000000197,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.8880719999999656,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.244497000000024,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.091915999999856,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.78927799999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.0042480000001887674,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5649695000001884,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004277000000001863,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.04360300000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.6934785000000261,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 1.0241600000000517,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.057206999999948,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.84209300000009,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 60.893185000000074,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 25.23296000000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5910.239769499996,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2353.281277500093,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "09224d4925e6ae53d85c09c8235c051fdc30c561",
          "message": "fix: mask shallow-boundary parents so commit walks stop at the cut (#260)",
          "timestamp": "2026-07-30T21:49:57+02:00",
          "tree_id": "25986f0be7cb6bd4fff0ba14e6bf1bf0117356ff",
          "url": "https://github.com/scolladon/tsgit/commit/09224d4925e6ae53d85c09c8235c051fdc30c561"
        },
        "date": 1785442321595,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 6.2085120000000416,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.3557700000000068,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 8.46874200000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.050859999999943284,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.048232999999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 23.426095999999916,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 8.924304000000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.5050229999999942,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.4798499999999422,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004427999999961685,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.3952320000003056,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.1974519999999984,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.1764080000000376,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.0469599999996717,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.0769445000000815,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 0.7786700000001474,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 22.758029999999962,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.2069794999997612,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 11.738435499999923,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 1.0892669999999498,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.1983859999999709,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.8785329999999476,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.420908999999938,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 36.94719050000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 588.324744,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 36.28043549999893,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.7913764999999557,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.280554000000393,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 53.996024499999976,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.224593500000026,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.4613849999998365,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.2646694999999681,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.0908605000000762,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.508705999999847,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 85.66688899999986,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.003701000000091881,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1093819999996413,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.00356999999985419,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 77.44590400000016,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.4361455000000092,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.6999019999999518,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.732108000000153,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.987277000000063,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 37.911374999999964,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.77380100000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4352.4313360000015,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1803.8920774999424,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "1098a2569edaa03179f57dd0be9ea14f3c99abac",
          "message": "chore(main): release 3.2.0 (#258)",
          "timestamp": "2026-07-31T14:16:27+02:00",
          "tree_id": "57b626704e9bae21bf9a2ba55bcef0ac258c3ee8",
          "url": "https://github.com/scolladon/tsgit/commit/1098a2569edaa03179f57dd0be9ea14f3c99abac"
        },
        "date": 1785501639202,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.530571000000009,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.4711205000000973,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 7.520717500000046,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.190860000000157,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 59.99431900000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 28.480281000000105,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.32410499999969034,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.43765799999982846,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 5.1461120000003575,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.375885500000095,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 39.95453799999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 31.88115000000016,
            "unit": "ms"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 9.050679500000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.7521425000000477,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 11.361284999999953,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.10701000000000249,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.570116999999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.774263000000246,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 13.895083,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5.177961000000096,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6288919999999507,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005208999999922526,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5964320000002772,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 3.156876000000011,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.9179200000000947,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.7059570000001258,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.7870479999999134,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 1.1991699999998673,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 29.33540499999981,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.7002360000005865,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 14.285167499999716,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 1.5150889999995343,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 663.4272265,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 317.6767550000004,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.951012999999989,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.2763240000001588,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.151147999999921,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 48.73693000000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 918.6316005000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 47.873758000001544,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.8902930000000424,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.39356499999985317,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 62.54897600000004,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.4428654999999253,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.253432000000089,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 2.000857499999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.3056485000000748,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.766941999999972,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 90.36860350000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004277999999885651,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.316619499999888,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.0042480000001887674,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 89.96393650000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.761812999999961,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 1.02981299999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.465217000000052,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.577759999999898,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 55.07918550000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 23.52839099999983,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5508.510662000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2223.1109999999753,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 1.8947545000000048,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.19516500000008818,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 1.8774869999999737,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.3684180000000197,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 1.8684299999999894,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.3680269999999837,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 2.044939000000113,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.3681575000000521,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "8229724cf4f66f3164b0620aae68418e247cdf59",
          "message": "fix: single-flight the pack registry so no FileHandle is orphaned to the garbage collector (#263)",
          "timestamp": "2026-08-01T13:51:22+02:00",
          "tree_id": "6b1fc8adfb5b8d2ee6201c35d6ab5b3744f837dc",
          "url": "https://github.com/scolladon/tsgit/commit/8229724cf4f66f3164b0620aae68418e247cdf59"
        },
        "date": 1785586643657,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.5379185000000462,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.3771429999999327,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 7.650714999999877,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 2.7774789999998575,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 62.25851200000011,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 27.7761959999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.3199990000002799,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.38751849999971455,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 5.1019264999999905,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 2.8529239999998026,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 42.12178200000017,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 29.72376600000098,
            "unit": "ms"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 8.13497099999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.689157000000023,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 11.802369999999883,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.07562099999995553,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.545861999999943,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.445902500000102,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 12.640316999999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4.461802000000034,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6385729999999512,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005658000000039465,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6291799999999057,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.8754769999999326,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.4347210000000814,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.4194609999999557,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.2516144999999597,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 0.9030000000002474,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 30.628148999999212,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.4512855000002673,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 12.93869100000029,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 1.4547385000005306,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 571.3795614999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 266.46997349999947,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.4643070000000762,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.0164910000000873,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.58113400000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 51.884387999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 769.4105835000009,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 52.729552000000695,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.8328020000001288,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3256025000000591,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 59.20254449999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.000274999999988,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.1074164999999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.456054999999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2033694999998943,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.090113000000201,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 80.48743700000023,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004597000000103435,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1223159999999552,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.0046469999997498235,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 79.74979449999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.6028839999999036,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.8325810000000047,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.049934000000121,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.79577249999977,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 51.018437999999946,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 20.10058200000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5210.471846499997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2008.6227000000654,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 1.8800269999999841,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.1963380000000825,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 1.8728970000001937,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.3939829999999347,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 1.890282500000012,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.39129400000001624,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 2.0313890000006722,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.39129400000001624,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "7143b9afcb988f63f3ce5094c1374faf55869acb",
          "message": "chore(main): release 3.2.1 (#264)",
          "timestamp": "2026-08-01T14:33:55+02:00",
          "tree_id": "54cbba66dc0cee175384c16e5debce9821589bf6",
          "url": "https://github.com/scolladon/tsgit/commit/7143b9afcb988f63f3ce5094c1374faf55869acb"
        },
        "date": 1785589148763,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.5544620000000577,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.4773920000000089,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 7.584544000000278,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.6954749999999876,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 60.953243499999644,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 31.93746199999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.32421900000008463,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.4432030000002669,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 5.176789000000099,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.6058319999997366,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 40.83503000000019,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 32.62399499999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 8.96106999999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.9680584999999269,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 11.38607300000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.10445650000002615,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 28.187573000000043,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 29.9329580000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 13.81056799999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4.946476999999959,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.748395999999957,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.00518000000010943,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6357740000003105,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 3.2415220000000318,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.9525539999999637,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.9783530000001974,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.499938999999813,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 1.181430000000546,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 30.586385999999493,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.7597179999993386,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 14.48329750000039,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 1.7095740000004298,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 691.6051729999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 347.6330734999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.7638149999999087,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.2191060000000107,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.63863399999991,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 51.11472099999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 947.2539795000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 51.750982500001555,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.9022009999999909,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.45151899999984835,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 63.02666749999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.372478000000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.6361689999999953,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.6668359999999325,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2573420000001079,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.417607999999746,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 100.45419149999975,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.006984000000556989,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.57787400000052,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004318000000239408,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 100.7898309999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.6926919999999654,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 1.004457500000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.906340499999942,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.656312999999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 54.295658,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 24.800537000000077,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5801.497202499995,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2338.7042945000576,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 1.9162109999999757,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.19516700000008314,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 1.8956530000000384,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.3682619999999588,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 1.8554974999999558,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.36783649999983936,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 2.029544000000442,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.3680370000001858,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "e6e1d7e577324359f4c25806bb2ba4daf0b4c0db",
          "message": "fix: accept pack version 3 and degrade unusable packs per-pack like git (#265)",
          "timestamp": "2026-08-07T16:48:45+02:00",
          "tree_id": "4fd72d93a917a8f0a47ce82cbc492a2afab19545",
          "url": "https://github.com/scolladon/tsgit/commit/e6e1d7e577324359f4c25806bb2ba4daf0b4c0db"
        },
        "date": 1786115604969,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.5334799999998268,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.5072310000000471,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 7.705433000000085,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.9455250000000888,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 60.67230399999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 31.527735499999835,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.31302199999981895,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.4671360000002096,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 5.092745999999806,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.71511400000054,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 40.711404000000584,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 32.99408249999942,
            "unit": "ms"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 9.174864999999954,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.9303275000000895,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 11.292965999999979,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.10590799999999945,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.336338999999953,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 29.503125000000182,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 14.3605510000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5.801815999999974,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5845580000000155,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005179999999654683,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.7249320000000807,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 3.552018000000089,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 3.3896389999999883,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.7985125000000153,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.6711290000002919,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 1.0865950000006706,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 29.054161999999906,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.9859235000003537,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 14.212617499999851,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 1.811952499999279,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 715.6136094999983,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 326.639862,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.824049000000059,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.365284499999973,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.277137999999923,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 47.101208999999926,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 955.1731330000011,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 46.66838900000221,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.9587115000000495,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.40994799999998577,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 65.15353949999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.597069499999975,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.3040699999999106,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.8975130000000036,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.3966550000000097,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.001674499999922,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 93.22282999999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004278000000340398,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2730239999991682,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004257999999936146,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 92.51986849999957,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.6810009999999806,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 1.1333735000000615,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.00685599999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.911550000000034,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 56.140101500000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 23.55329400000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5834.484974000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2287.312665999867,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 1.921280500000023,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.19515599999999722,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 1.9049199999999473,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.3682800000001407,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 1.8670594999998684,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.3684499999999389,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 2.0888299999999163,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.3685099999997874,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "7bf44695d9028a84b4135f698d4b46d37e4886ec",
          "message": "fix: report inaccessible packs and unreadable objects from fsck like git (#267)",
          "timestamp": "2026-08-08T01:53:52+02:00",
          "tree_id": "25d838e1efc8c28cfa64b08b9cadfd450ec577bb",
          "url": "https://github.com/scolladon/tsgit/commit/7bf44695d9028a84b4135f698d4b46d37e4886ec"
        },
        "date": 1786148318581,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.5184690000000387,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.4984465,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 7.561288999999988,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.3127330000002075,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 59.81884450000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 25.64320299999963,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.3231070000001637,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.4312100000006467,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 5.105489999999918,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.179297499999848,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 40.353845999999976,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 30.495316000000457,
            "unit": "ms"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 9.044962999999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.7797974999999724,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 11.138755499999888,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.10192100000006121,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.924554500000056,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.26194350000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 13.562992000000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5.61179199999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6499989999999798,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005159999999932552,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.648486000000048,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 3.2780164999999784,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 3.2431060000000116,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.6904749999998785,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.5919699999999466,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 1.2076590000001488,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 28.68385649999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 2.0008379999999306,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 13.658054499999707,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 1.6350844999997207,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 657.507256500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 302.8054704999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.7808339999999134,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.203300000000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.118359000000055,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 47.57139500000039,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 920.0868929999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 46.95352599999751,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.9242805000000089,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.39473099999986516,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 63.117296999999894,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.490927500000055,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.0514670000000024,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 2.0241770000000088,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1566229999999678,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.101231999999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 90.56223399999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004247999999279273,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1801504999998542,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004267999999683525,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 89.74025249999977,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.7302680000000237,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 1.0436999999999443,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.652005000000145,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.524569000000156,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 54.68696799999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 22.34217099999978,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5414.666270500002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2180.840704999864,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 1.888417000000004,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.1951970000000074,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 1.8793900000000576,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.3682920000001104,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 1.8856464999998934,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.3684310000003279,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 2.073323999999957,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.36845200000061595,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "a4a166385f6b78c17be31ef6df14bc913f1c9cc6",
          "message": "feat: make the object-store gate the multi-pack-index load alone (#274)",
          "timestamp": "2026-08-15T10:09:58+02:00",
          "tree_id": "629dc285e75bdfc93000095ced8da8906f011f62",
          "url": "https://github.com/scolladon/tsgit/commit/a4a166385f6b78c17be31ef6df14bc913f1c9cc6"
        },
        "date": 1786782977846,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.6177665000000161,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.378740500000049,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 8.991434000000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 2.5970554999998967,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 71.88229550000028,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 28.1419034999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.34138050000001385,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.38291099999969447,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 5.633120000000417,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.451720000000023,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 47.98403999999937,
            "unit": "ms"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 31.202460499999688,
            "unit": "ms"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 5.959039500000017,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.5824539999999843,
            "unit": "ms"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 12.089490000000069,
            "unit": "ms"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.06542899999999463,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 24.029602999999952,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.31120400000009,
            "unit": "ms"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When revList() computes the closure at its own default (a walk), Then measure tsgit > tsgit",
            "value": 6.223251000000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When packObjects() computes the closure at its own default (a usable bitmap), Then measure tsgit > tsgit",
            "value": 43.91245200000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 9.744451000000026,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.800328000000036,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6507834999999886,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005733999999847583,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5574494999998478,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.1324114999999324,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.1187249999999267,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.1581850000000031,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.0646139999998923,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 0.776644000000033,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 28.688539499999933,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.1756259999997383,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 12.815809499999887,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 1.084373499999856,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 492.39008099999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 297.54046650000055,
            "unit": "ms"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.3132110000000239,
            "unit": "ms"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given a many-object pack (3000 objects) with no .rev and no .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 350.4218199999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given the same many-object pack carrying a healthy .rev and .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 381.9384399999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.039485999999954,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.54189400000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 54.83491500000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 749.5048404999989,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 54.15291049999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.8111860000001343,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.34720499999991716,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.16344149999986257,
            "unit": "ms"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.31570300000021234,
            "unit": "ms"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 47.85488149999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a single-pack repo (1 commits, 1 blobs), When readBlob() resolves the only pack (P = 1, no midx), Then measure tsgit > tsgit",
            "value": 0.003452999999808526,
            "unit": "ms"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When readBlob() resolves a loose object with no packs (the assertLoadable gate, isolated), Then measure tsgit > tsgit",
            "value": 0.17317899999989095,
            "unit": "ms"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the first pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.003539000000273518,
            "unit": "ms"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the last pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.0034420000001773587,
            "unit": "ms"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the first pack with no midx, Then measure tsgit > tsgit",
            "value": 0.003501000000142085,
            "unit": "ms"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the last pack with no midx, Then measure tsgit > tsgit",
            "value": 0.003470999999990454,
            "unit": "ms"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When a cold open reads one blob with a midx present, Then measure tsgit > tsgit",
            "value": 1.7665090000000419,
            "unit": "ms"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When a cold open reads one blob with no midx, Then measure tsgit > tsgit",
            "value": 9.813458999999966,
            "unit": "ms"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open reads one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 0.7739819999997053,
            "unit": "ms"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open streams one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 0.9916874999998981,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.280661000000009,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.1367830000000367,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given a many-object pack (3000 objects) with a healthy .rev present, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.7633215000000746,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-object pack with its .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.6890730000000076,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given many small packs (64 packs, 4 objects each) with a healthy .rev in every pack, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 14.064245999999912,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-small-packs repository with every .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 14.88760400000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.2414104999999722,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1240999999999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.306700999999862,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.95750649999991,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004641000000447093,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.3865559999999277,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004726999999547843,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 94.70009649999974,
            "unit": "ms"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.4324130000001105,
            "unit": "ms"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.5907069999999521,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.3666634999999587,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.36371650000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 31.828611499999965,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 23.003283999999894,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3561.823801999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1905.3018525000662,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 2.16933599999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.2047514999999862,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 2.4547000000000025,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.4330325000003086,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 2.296061000000009,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.4240469999999732,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 2.1992410000002565,
            "unit": "ms"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.41529000000082306,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "46c6bd1c7d8791143f281260548dc2c232807ee6",
          "message": "fix: make the tree-depth caps bound what they claim, and track Node release lines by alias (#275)",
          "timestamp": "2026-08-16T13:59:16+02:00",
          "tree_id": "3f5b714297cf42c9514a22ea73cf7fcd3ec88bce",
          "url": "https://github.com/scolladon/tsgit/commit/46c6bd1c7d8791143f281260548dc2c232807ee6"
        },
        "date": 1786882952953,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.5267130000000861,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.4365895000000819,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 16.078252000000248,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.0538265000000138,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 133.2516579999999,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 33.58984250000003,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.3214490000000296,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.3809209999999439,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 5.157792999999856,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.5125984999999673,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 39.99202499999956,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 33.14957900000081,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 7.291141499999924,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.8540484999999762,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 11.356831499999998,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.07933300000001964,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.94204449999995,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.53403900000012,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When revList() computes the closure at its own default (a walk), Then measure tsgit > tsgit",
            "value": 4.128176000000053,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When packObjects() computes the closure at its own default (a usable bitmap), Then measure tsgit > tsgit",
            "value": 55.801963500000056,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 11.732356999999979,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5.076347999999996,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.7048600000000533,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005349999999907595,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5631149999999252,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.549786499999925,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.475597999999991,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.39210700000001,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.464230999999927,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 1.1294414999999844,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 25.549158999999918,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.4689899999998488,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 13.248638999999457,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 1.4533115000003818,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 565.8186664999994,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 316.1319459999995,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.6124679999999216,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given a many-object pack (3000 objects) with no .rev and no .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 527.233855,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given the same many-object pack carrying a healthy .rev and .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 550.9826240000002,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.1968329999999696,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.708045999999968,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 42.31602249999992,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 958.5391734999994,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 44.60679699999855,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.1311490000000504,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4372360000002118,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.22041650000005575,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.40450399999986075,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 50.827913999999964,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a single-pack repo (1 commits, 1 blobs), When readBlob() resolves the only pack (P = 1, no midx), Then measure tsgit > tsgit",
            "value": 0.0030759999999645515,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When readBlob() resolves a loose object with no packs (the assertLoadable gate, isolated), Then measure tsgit > tsgit",
            "value": 0.2204669999998714,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the first pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.0031959999996615807,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the last pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.003176000000166823,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the first pack with no midx, Then measure tsgit > tsgit",
            "value": 0.0031950000002325396,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the last pack with no midx, Then measure tsgit > tsgit",
            "value": 0.003155999999762571,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When a cold open reads one blob with a midx present, Then measure tsgit > tsgit",
            "value": 2.342830999999933,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When a cold open reads one blob with no midx, Then measure tsgit > tsgit",
            "value": 12.079415000000154,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open reads one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 0.9455440000001545,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open streams one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 1.0526740000004793,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.9015925000000493,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.5592139999998835,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given a many-object pack (3000 objects) with a healthy .rev present, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.8128870000000461,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-object pack with its .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.7792240000001129,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given many small packs (64 packs, 4 objects each) with a healthy .rev in every pack, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 20.073591999999735,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-small-packs repository with every .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 19.892123999999967,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.8168394999999578,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.3456155000001218,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4.167329499999823,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 87.33617400000003,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004468000000088068,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6338580000001457,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004477999999835447,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 87.25522199999978,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.5805629999999837,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.7998929999999973,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.855181499999958,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.613290000000006,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 34.34268599999996,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 21.8347715000001,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3749.314854000002,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2212.1506894999766,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 1.985904999999974,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.475648000000092,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 1.9038470000000416,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.41878699999983837,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 1.877020999999786,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.3828645000000961,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 1.8793960000002699,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.36855800000012096,
            "unit": "ms",
            "extra": "v24.19.0"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "3f5b9ba6a665056aa04387fb227932e3afb1af91",
          "message": "perf: remediate the 2026-08-16 performance review (#276)",
          "timestamp": "2026-08-16T21:41:31+02:00",
          "tree_id": "e769ce33e902513200233dabcb575a173db4443e",
          "url": "https://github.com/scolladon/tsgit/commit/3f5b9ba6a665056aa04387fb227932e3afb1af91"
        },
        "date": 1786909839092,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.5269455000000107,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.4290335000000596,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 16.030430000000024,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.5410845000001245,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 131.45780250000007,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 28.891110000000026,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.32238999999935913,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.39709900000070775,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 5.644980000000032,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.427949000000808,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 39.44939300000078,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 32.91798899999958,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 7.438844000000017,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.8790570000001026,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 11.672091000000137,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.09793249999995624,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.427599999999984,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.62778299999991,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When revList() computes the closure at its own default (a walk), Then measure tsgit > tsgit",
            "value": 4.632830000000013,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When packObjects() computes the closure at its own default (a usable bitmap), Then measure tsgit > tsgit",
            "value": 55.54946199999995,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 11.952289000000007,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4.58506199999988,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.657905000000028,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005460000000311993,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5923769999999422,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.4136949999999615,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.2709140000001753,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.3979760000001988,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.2082784999997784,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 0.9432204999993701,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 25.9940674999998,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.524519999999029,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 13.184739000000263,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 1.3542900000011286,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 561.5069834999995,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 314.77980650000063,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.5242815000000292,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given a many-object pack (3000 objects) with no .rev and no .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 553.4082360000002,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given the same many-object pack carrying a healthy .rev and .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 520.336827000001,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.1206805000001623,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.732213999999658,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 45.23624600000039,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 937.9976379999989,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 46.9778409999999,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.01017800000011,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.38431500000024243,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.21100299999989147,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3667230000000927,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 52.64876250000009,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a single-pack repo (1 commits, 1 blobs), When readBlob() resolves the only pack (P = 1, no midx), Then measure tsgit > tsgit",
            "value": 0.0033160000002681045,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When readBlob() resolves a loose object with no packs (the assertLoadable gate, isolated), Then measure tsgit > tsgit",
            "value": 0.2082775000003494,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the first pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.0033760000005713664,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the last pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.003365999999914493,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the first pack with no midx, Then measure tsgit > tsgit",
            "value": 0.003366999999343534,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the last pack with no midx, Then measure tsgit > tsgit",
            "value": 0.0033660000008239876,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When a cold open reads one blob with a midx present, Then measure tsgit > tsgit",
            "value": 2.190915999999561,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When a cold open reads one blob with no midx, Then measure tsgit > tsgit",
            "value": 13.085776500000065,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open reads one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 0.9833499999986088,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open streams one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 1.2174150000009831,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.134232000000054,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.031711499999915,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given a many-object pack (3000 objects) with a healthy .rev present, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.8431089999999131,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-object pack with its .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.7834880000000339,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given many small packs (64 packs, 4 objects each) with a healthy .rev in every pack, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 19.924477999999908,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-small-packs repository with every .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 19.71641899999986,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.5512689999999338,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2825735000000122,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.326689500000157,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 90.03234299999986,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004437999999936437,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2176159999999072,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004409000000123342,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 85.54626700000017,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.5479249999999638,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.7605004999999778,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.862282499999992,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.369509999999991,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.34693500000003,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 24.197881000000052,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 706.0960525000005,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2259.0136804999984,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 2.0019849999999906,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.27389900000002854,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 1.8395230000000993,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.39655800000036834,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 1.8077289999998811,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.38498699999991004,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 1.840516000000207,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.3680349999995087,
            "unit": "ms",
            "extra": "v24.19.0"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "c5f660527160248c7b6df4623c103ea39e25f550",
          "message": "chore(main): release 3.4.0 (#272)",
          "timestamp": "2026-08-16T22:05:27+02:00",
          "tree_id": "fa8cf8ffee15df2ed93b66d45a14b70be3ec29e8",
          "url": "https://github.com/scolladon/tsgit/commit/c5f660527160248c7b6df4623c103ea39e25f550"
        },
        "date": 1786912125421,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.530637499999898,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.4265779999998358,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 16.12338499999987,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.038336999999956,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 131.44412399999965,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 30.435713000000305,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.3211055000001579,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.4003900000006979,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 5.206522999999834,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.571903999999904,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 39.49591999999939,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 32.45748800000001,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 7.228875000000016,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.8909629999999993,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 11.42424549999987,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.10425499999996646,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.765075499999966,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.364393500000006,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When revList() computes the closure at its own default (a walk), Then measure tsgit > tsgit",
            "value": 4.576705999999831,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When packObjects() computes the closure at its own default (a usable bitmap), Then measure tsgit > tsgit",
            "value": 57.40144850000024,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 11.331466499999976,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4.654211000000032,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6838614999999209,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005298999999922671,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5941440000001421,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.679405000000088,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.6566119999999955,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.4695854999999938,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.3241689999999835,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 0.9758160000001226,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 26.17022599999973,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.5085229999999683,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 14.445448999999826,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 1.4262390000003506,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 566.8193625000004,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 326.83102300000064,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.4990094999999428,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given a many-object pack (3000 objects) with no .rev and no .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 517.7313455000003,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given the same many-object pack carrying a healthy .rev and .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 532.5303820000008,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.1742880000000468,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.22789350000005,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 43.34602300000006,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 930.6652320000003,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 45.47120300000097,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.0156099999999242,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.43077100000016344,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.22899899999993067,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.38560099999995145,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 50.53323449999988,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a single-pack repo (1 commits, 1 blobs), When readBlob() resolves the only pack (P = 1, no midx), Then measure tsgit > tsgit",
            "value": 0.003176000000166823,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When readBlob() resolves a loose object with no packs (the assertLoadable gate, isolated), Then measure tsgit > tsgit",
            "value": 0.22159499999997934,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the first pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.0032959999998638523,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the last pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.0032860000001164735,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the first pack with no midx, Then measure tsgit > tsgit",
            "value": 0.0032760000003690948,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the last pack with no midx, Then measure tsgit > tsgit",
            "value": 0.003276999999798136,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When a cold open reads one blob with a midx present, Then measure tsgit > tsgit",
            "value": 2.186362999999801,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When a cold open reads one blob with no midx, Then measure tsgit > tsgit",
            "value": 14.038755000000037,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open reads one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 0.9819479999996474,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open streams one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 1.0324820000005275,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.757709499999919,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.7434719999998833,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given a many-object pack (3000 objects) with a healthy .rev present, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.8106219999999666,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-object pack with its .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.7837515000001076,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given many small packs (64 packs, 4 objects each) with a healthy .rev in every pack, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 19.691553000000113,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-small-packs repository with every .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 20.134726000000228,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.809325000000058,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.3017160000001695,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.6555700000003526,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 90.23633600000016,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004447999999683816,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2284984999996595,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004407999999784806,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 90.18935250000004,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.5578889999999888,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.7948480000000018,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.8317480000000614,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.213183999999842,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 33.8393815,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 22.49469799999997,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3742.4248929999976,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2166.5257415000233,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 2.32112699999999,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.21720600000003287,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 1.7795540000000756,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.3764339999997901,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 1.7618310000000292,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.3686400000001413,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 1.8360649999999623,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.36812800000006973,
            "unit": "ms",
            "extra": "v24.19.0"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "d3a3af485dc7af28211e1c92748c9f6c4082e756",
          "message": "feat: bare repositories, explicit layout arguments, and faithful work-tree refusals (#277)",
          "timestamp": "2026-08-18T22:02:59+02:00",
          "tree_id": "69ec7192f0eb4120fe7a92eae6d1548fa9bdcc3e",
          "url": "https://github.com/scolladon/tsgit/commit/d3a3af485dc7af28211e1c92748c9f6c4082e756"
        },
        "date": 1787084755336,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.4162549999999783,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.2592029999998431,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 12.351670500000068,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 2.0444184999998924,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 98.18120350000004,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 22.69397900000058,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.26601300000038464,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.2615814999999202,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 4.292672500000208,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 2.203543500000251,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 34.361533999999665,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 25.815075000000434,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 4.887957500000027,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.3500659999999698,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 8.56301649999989,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.1976475000000164,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 23.180699500000003,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 25.451707999999826,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When revList() computes the closure at its own default (a walk), Then measure tsgit > tsgit",
            "value": 4.605890999999929,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When packObjects() computes the closure at its own default (a usable bitmap), Then measure tsgit > tsgit",
            "value": 34.23860999999988,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 7.712975000000029,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.6799720000000207,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2793910000000324,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.0045370000002549205,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1961839999999029,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 1.6963690000000042,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 1.5887149999999792,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.4139710000001742,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.1746969999999237,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 1.0036345000000892,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 20.165639000000283,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.4291040000002795,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 10.649775999999747,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 1.3170179999997345,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 389.79931150000084,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 188.22200600000087,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.3761749999999324,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given a many-object pack (3000 objects) with no .rev and no .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 327.47493850000023,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given the same many-object pack carrying a healthy .rev and .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 322.8662869999994,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.0346294999999373,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 6.890250000000151,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 37.08903250000003,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 619.6873025,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 39.01094899999953,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.031330500000081,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.24987899999996444,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.12080349999996542,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.22882349999986218,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 36.258023000000094,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a single-pack repo (1 commits, 1 blobs), When readBlob() resolves the only pack (P = 1, no midx), Then measure tsgit > tsgit",
            "value": 0.002594000000044616,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When readBlob() resolves a loose object with no packs (the assertLoadable gate, isolated), Then measure tsgit > tsgit",
            "value": 0.12856499999975313,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the first pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.0026739999993878882,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the last pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.0026539999998931307,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the first pack with no midx, Then measure tsgit > tsgit",
            "value": 0.0026939999997921404,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the last pack with no midx, Then measure tsgit > tsgit",
            "value": 0.0026539999998931307,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When a cold open reads one blob with a midx present, Then measure tsgit > tsgit",
            "value": 1.747163499999715,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When a cold open reads one blob with no midx, Then measure tsgit > tsgit",
            "value": 8.916205000000446,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open reads one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 0.9455789999992703,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open streams one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 1.143966999999975,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.073906999999963,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 1.8474670000000515,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given a many-object pack (3000 objects) with a healthy .rev present, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.48687500000005457,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-object pack with its .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.4624190000000681,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given many small packs (64 packs, 4 objects each) with a healthy .rev in every pack, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 10.99473799999987,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-small-packs repository with every .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 11.689636500000006,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.4520169999999553,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.9392789999999422,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.0799050000000534,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 63.39909800000032,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.003784999999879801,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.9068619999998191,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.0037959999999657157,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 62.830707000000075,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.4519180000000347,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.7766185000000405,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 2.6423070000000735,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.678813500000047,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 21.833635499999957,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.010857999999871,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 2709.242477,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1511.6156640000409,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 1.4578409999999735,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.17115300000000389,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 1.3735110000000077,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.3045609999999215,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 1.405757999999878,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.30389900000000125,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 1.4390825000000405,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.30391899999995076,
            "unit": "ms",
            "extra": "v24.19.0"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "3da7be188bbcc1532bbe75b8d2da264f54ad4128",
          "message": "feat: refuse repositories git refuses — repository-format and ownership-trust acceptance gates (#279)",
          "timestamp": "2026-08-20T13:30:29+02:00",
          "tree_id": "263ce251a8108e6d3dd85e1eb3e45034be72247a",
          "url": "https://github.com/scolladon/tsgit/commit/3da7be188bbcc1532bbe75b8d2da264f54ad4128"
        },
        "date": 1787226858825,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.5845929999998134,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.3222249999998894,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 15.989272000000028,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 2.4124080000001413,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 127.42682499999978,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 26.899006000000554,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.3419289999992543,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.31649200000038036,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 5.4738139999999476,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 2.602108000000044,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 43.880809500001305,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 29.67097499999909,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 6.524799999999971,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.7859245000000215,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 11.073114999999916,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.2601839999999811,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.66083249999997,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.5149265,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When revList() computes the closure at its own default (a walk), Then measure tsgit > tsgit",
            "value": 4.523011499999939,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When packObjects() computes the closure at its own default (a usable bitmap), Then measure tsgit > tsgit",
            "value": 44.83776450000005,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 10.266635000000065,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4.400576000000001,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5998049999999466,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005757999999786989,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5138229999997748,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.242097000000058,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.0898819999999887,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.6692470000000412,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.5601610000001074,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 1.3659749999997075,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 31.486983000000237,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.7085855000000265,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 13.125289000000066,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 1.6629324999994424,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 441.0237619999998,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 225.41552299999967,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.8517419999999447,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given a many-object pack (3000 objects) with no .rev and no .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 418.7325115000003,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given the same many-object pack carrying a healthy .rev and .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 425.6021500000006,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.3922939999999926,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.756452000000081,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 44.37870100000009,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 761.2348569999995,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 47.607334000000264,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.3328709999999546,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3189709999999195,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.17409200000020064,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3001129999997829,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 46.59545600000001,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a single-pack repo (1 commits, 1 blobs), When readBlob() resolves the only pack (P = 1, no midx), Then measure tsgit > tsgit",
            "value": 0.003294999999980064,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When readBlob() resolves a loose object with no packs (the assertLoadable gate, isolated), Then measure tsgit > tsgit",
            "value": 0.1564210000001367,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the first pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.003434999999626598,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the last pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.0033849999999802094,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the first pack with no midx, Then measure tsgit > tsgit",
            "value": 0.003343999999742664,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the last pack with no midx, Then measure tsgit > tsgit",
            "value": 0.0033750000002328306,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When a cold open reads one blob with a midx present, Then measure tsgit > tsgit",
            "value": 2.3632299999999304,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When a cold open reads one blob with no midx, Then measure tsgit > tsgit",
            "value": 9.96066350000001,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open reads one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 1.3623489999999947,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open streams one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 1.5592399999995905,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.5847020000001066,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.3957635000000437,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given a many-object pack (3000 objects) with a healthy .rev present, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.6253429999999867,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-object pack with its .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.5882970000000114,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given many small packs (64 packs, 4 objects each) with a healthy .rev in every pack, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 13.842499999999745,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-small-packs repository with every .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 13.713096999999834,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.8566800000000967,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2064155000000483,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.7692520000000513,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 75.87727800000016,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.00480699999980061,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1376585000002706,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004778000000442262,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 75.62949750000007,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.5650635000000079,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 1.0313470000000393,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.3823489999999765,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.257461000000035,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.555826999999965,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 17.96462400000007,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3317.8099760000005,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1875.756351499993,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 2.156097499999987,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.2203149999999141,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 1.7207949999999528,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.3912179999997534,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 1.7364430000000084,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.39159799999993083,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 1.7399279999999635,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.39123749999998836,
            "unit": "ms",
            "extra": "v24.19.0"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "ed7ca3dfbde6a463518c7c73355ac77fe6a7021b",
          "message": "feat: SHA-256 object format at full write parity, plus bundle v3 (#280)",
          "timestamp": "2026-08-21T23:53:45+02:00",
          "tree_id": "b6b8d785737efc7c3293305040a027dc5d205f87",
          "url": "https://github.com/scolladon/tsgit/commit/ed7ca3dfbde6a463518c7c73355ac77fe6a7021b"
        },
        "date": 1787350846244,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.5316209999998591,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.4135909999999967,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 16.170464000000266,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 2.9961050000001705,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 132.7677649999996,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 30.42802500000016,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.3218200000001161,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.3845320000000356,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 5.184817000000294,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 3.6793100000004415,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 39.405822000000626,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 33.030886000000464,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 7.93626549999999,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 2.185758999999962,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 12.23390449999988,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.298246000000006,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.428506999999968,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 32.61649049999983,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When revList() computes the closure at its own default (a walk), Then measure tsgit > tsgit",
            "value": 5.161319000000049,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When packObjects() computes the closure at its own default (a usable bitmap), Then measure tsgit > tsgit",
            "value": 51.53895899999998,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 12.431727999999907,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5.53216249999997,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6692720000000918,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005390000000261352,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5986900000000333,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.9921880000000556,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.7078579999999874,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 2.1011519999999564,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.9509719999999788,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 1.6414294999999584,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 26.97633599999972,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.9632554999996046,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 15.088329999999587,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 2.1588429999992513,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 594.7137639999992,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 328.793549,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 2.231864500000029,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given a many-object pack (3000 objects) with no .rev and no .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 538.2654990000001,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given the same many-object pack carrying a healthy .rev and .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 559.8522690000009,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.8122335000000476,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.026244499999962,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 48.181838999999854,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 937.6484604999996,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 50.46403900000223,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.5866580000001704,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.40169350000007853,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.24551800000017465,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3646040000000994,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 54.776894500000026,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a single-pack repo (1 commits, 1 blobs), When readBlob() resolves the only pack (P = 1, no midx), Then measure tsgit > tsgit",
            "value": 0.003206000000318454,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When readBlob() resolves a loose object with no packs (the assertLoadable gate, isolated), Then measure tsgit > tsgit",
            "value": 0.19939100000010512,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the first pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.0032459999997627165,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the last pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.0032359999995605904,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the first pack with no midx, Then measure tsgit > tsgit",
            "value": 0.0032260000007227063,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the last pack with no midx, Then measure tsgit > tsgit",
            "value": 0.0032259999998132116,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When a cold open reads one blob with a midx present, Then measure tsgit > tsgit",
            "value": 2.650123999999778,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When a cold open reads one blob with no midx, Then measure tsgit > tsgit",
            "value": 15.110674999999901,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open reads one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 1.4997070000008534,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open streams one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 1.7847295000001395,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.948261500000001,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.2473485000000437,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given a many-object pack (3000 objects) with a healthy .rev present, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.8308739999999943,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-object pack with its .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.7563299999999344,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given many small packs (64 packs, 4 objects each) with a healthy .rev in every pack, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 19.241239499999892,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-small-packs repository with every .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 18.370014999999967,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 2.3249110000000996,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2679200000000037,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4.213512999999921,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 94.27203799999984,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004468000000088068,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.31838899999957,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004449000000022352,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 94.87373250000064,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.7532699999999863,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 1.288233000000048,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4.164671999999882,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.360492999999678,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 34.69179349999996,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 23.396401999999853,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3808.4786829999994,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2282.0308519999962,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 1.8531520000000228,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.467441000000008,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 1.909005999999863,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.4317790000000059,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 1.869166999999834,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.37183299999992414,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 1.9305679999997665,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.3685169999998834,
            "unit": "ms",
            "extra": "v24.19.0"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "6fb2e643c20f3abd51a79bd515ca28182d539a9a",
          "message": "feat: reftable ref storage as a complete backend — read, write and compaction (#281)\n\nImplements `extensions.refStorage` as a complete reftable backend — read, write **and** compaction — and removes `refStorage` from the repository-format gate's point-of-use refuse set.\n\n## What lands\n\n- **A backend-neutral `RefStore`.** `listRefs`, `resolveDirect`, `applyRefUpdates`, `readReflog`, `listReflogs`, `verifyIntegrity` and two new seam verbs (`listRefNames`, `hasReflog`) are implemented by both the files and reftable backends, selected from the repository layout.\n- **The reftable codec in `domain/refs`** — headers and footers in both hash widths, ref/index/obj/log blocks, varints, restart points, prefix compression, tombstones — with zero platform dependencies.\n- **Writes through git's stack-lock protocol**, geometric auto-compaction, and a `packRefs` surface where orphaned-table cleanup lives (the same place git does it).\n- **Reflogs on the same seam**, including `reflogReplace`, so `branchRename` moves history the way git does instead of leaving both branches.\n\n## Faithfulness\n\nEverything is pinned against real git 2.55.0 by cross-tool interop tests, not by reasoning. Two divergences are deliberate and recorded:\n\n- **ADR-708** — the reader refuses hostile input git accepts. Measured: git's reftable reader enforces no `tables.list` name grammar and will follow `../../../outside/escape.ref` out of the reftable directory. tsgit refuses that, plus a cyclic ref index, unbounded log inflation, and absurd table counts/sizes. The justification is embedding context, not faithfulness: git is a process a user can kill, tsgit is a library inside a host that never opted in.\n- **ADR-688** (pre-existing, unchanged) — where git's own `fsck` crashes on a corrupt stack, tsgit refuses with a structured code.\n\nOne **pre-existing faithfulness bug** is fixed along the way: tsgit wrote `branch: renamed …` where git writes `Branch: renamed …` — wrong on **both** backends, and `design/reflog.md`'s own \"matches canonical git wording\" table carried the same wrong literal.\n\n## Notable\n\nThe reftable format is one where a passing test suite proves very little: tsgit's reader and writer agreed with each other while disagreeing with git. Every real bug here was found by measuring against the git binary — a mirror-imaged index position, a sole block padded where git leaves it bare, and a record sort order that silently corrupted git's own restart-based binary search.\n\nThe backend-neutral seam also regressed the **files** backend for users who never touch reftable — a whole-namespace walk where one `readdir` sufficed, an O(N·P) packed scan, and per-ref reads in an operation that previously did none. Those are repaired here, with the reductions argued by syscall and complexity counts rather than local timings.\n\n## Verification\n\n`npm run validate` green; interop, parity and browser tiers included. Mutation testing run and triaged separately.",
          "timestamp": "2026-08-23T15:22:56+02:00",
          "tree_id": "6b2d393d0317cea27124bea7ac94b71ce9e9a242",
          "url": "https://github.com/scolladon/tsgit/commit/6fb2e643c20f3abd51a79bd515ca28182d539a9a"
        },
        "date": 1787492892727,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.5229904999999349,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.33190799999999854,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 16.133506000000125,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 2.379762000000028,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 126.5583739999995,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB highly compressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 28.104668500000116,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 0.33980999999948835,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 64 KiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 0.31889900000032867,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 5.5153934999998455,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 1 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 2.7500270000000455,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit > tsgit",
            "value": 44.80118500000026,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/adapter-inflate.bench.ts > Given a 8 MiB incompressible zlib member, When native DecompressionStream decodes it, Then measure tsgit > tsgit",
            "value": 31.423894499999733,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/add.bench.ts > Given a freshly built scratch repo with two unstaged files, When add() stages them all, Then measure tsgit > tsgit",
            "value": 6.7326044999999795,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-small deep-ancestry repo (50 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 1.6812290000000303,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/blame.bench.ts > Given a deep-ancestry-medium deep-ancestry repo (500 commits), When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 11.267037000000073,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/cat-file.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When catFile() reads the HEAD commit, Then measure tsgit > tsgit",
            "value": 0.2730099999999993,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 28.570802999999955,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.48398300000008,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When revList() computes the closure at its own default (a walk), Then measure tsgit > tsgit",
            "value": 4.514162999999826,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/closure.bench.ts > Given a 500-commit repository with a healthy bitmap, When packObjects() computes the closure at its own default (a usable bitmap), Then measure tsgit > tsgit",
            "value": 42.177108999999746,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/commit.bench.ts > Given a freshly built scratch repo with one staged file, When commit() records it, Then measure tsgit > tsgit",
            "value": 10.38236900000004,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4.529910500000028,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5711539999999786,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.005717999999887979,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.4824949999997443,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a small repo (50 commits, 200 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 2.1597320000000764,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 1.8771185000000514,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.581583000000137,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively, Then measure tsgit > tsgit",
            "value": 1.3228970000000118,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 1.2230169999997997,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares the empty tree against HEAD recursively (the merge-join walks the whole tree), Then measure tsgit > tsgit",
            "value": 26.242365500000005,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a small repo (50 commits, 200 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 1.5964670000000751,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-recursive.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD against a sibling tree with one blob modified per shard directory, Then the cursor merge-join descends every directory pair instead of expanding an added subtree > tsgit",
            "value": 14.164088500000162,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all' over add-only changes (non-regression watch — never reaches the whitespace drop-pass predicate), Then measure tsgit > tsgit",
            "value": 1.4870319999990897,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, loose (as committed), When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 458.27090150000004,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff-whitespace.bench.ts > Given a scratch repo of 2,500 whitespace-only-modified file pairs, packed via `git repack -ad`, When diff() compares HEAD~1 against HEAD recursively with ignoreWhitespace:'all', Then measure tsgit > tsgit",
            "value": 242.40892350000104,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/diff.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When diff() compares HEAD~1 against HEAD, Then measure tsgit > tsgit",
            "value": 1.669456000000082,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given a many-object pack (3000 objects) with no .rev and no .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 410.6205725,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/fsck-artefacts.bench.ts > Given the same many-object pack carrying a healthy .rev and .bitmap, When fsck() audits the repository, Then measure tsgit > tsgit",
            "value": 407.75663650000024,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.2757050000000163,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a small repo (50 commits, 200 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.342474999999922,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 47.88412299999982,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 758.0775485000004,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/log.bench.ts > Given a medium-commit-graph repo (5000 commits, 20000 blobs), When log() walks every commit via a written commit-graph, Then measure tsgit > tsgit",
            "value": 49.59327800000028,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.45142450000003,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3426550000000361,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.16599949999999808,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/loose-read.bench.ts > Given a repository handle opened once and reused across calls, When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.319629999999961,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/merge.bench.ts > Given two branches diverging by one disjoint-file commit each, When merge.run() creates a non-fast-forward merge, Then measure tsgit > tsgit",
            "value": 47.7564450000001,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a single-pack repo (1 commits, 1 blobs), When readBlob() resolves the only pack (P = 1, no midx), Then measure tsgit > tsgit",
            "value": 0.003244999999878928,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When readBlob() resolves a loose object with no packs (the assertLoadable gate, isolated), Then measure tsgit > tsgit",
            "value": 0.16274499999963155,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the first pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.0033650000000307045,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When readBlob() hits the last pack with a midx present, Then measure tsgit > tsgit",
            "value": 0.0033549999998285784,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the first pack with no midx, Then measure tsgit > tsgit",
            "value": 0.0033450000000811997,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When readBlob() hits the last pack with no midx, Then measure tsgit > tsgit",
            "value": 0.003335000000333821,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack repo (48 commits, 48 blobs), When a cold open reads one blob with a midx present, Then measure tsgit > tsgit",
            "value": 2.4006919999992533,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a many-pack-no-midx repo (48 commits, 48 blobs), When a cold open reads one blob with no midx, Then measure tsgit > tsgit",
            "value": 10.762567499999932,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open reads one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 1.2544969999999012,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/midx-lookup.bench.ts > Given a loose-only repo (1 commits, 1 blobs), When a cold open streams one loose blob with no packs, Then measure tsgit > tsgit",
            "value": 1.5167505000008532,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a small repo (50 commits, 200 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.477074499999958,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.4164180000000215,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given a many-object pack (3000 objects) with a healthy .rev present, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.6170260000001235,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-object pack with its .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 0.6102260000000115,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given many small packs (64 packs, 4 objects each) with a healthy .rev in every pack, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 13.320661499999915,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-offset-table.bench.ts > Given the same many-small-packs repository with every .rev deleted, When buildOffsetTable() runs on every registered pack, Then measure tsgit > tsgit",
            "value": 14.368594999999914,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1.896918999999798,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1846239999999852,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4.004743499999904,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 77.00935100000015,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004726999999547843,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a small repo (50 commits, 200 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1510079999998197,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.004748000000290631,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/pack-read.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 77.02598199999966,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/rev-parse.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When revParse() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.5259299999999598,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/show.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When show() resolves HEAD, Then measure tsgit > tsgit",
            "value": 0.9592909999999506,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3.4854779999999437,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status-dirty.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.539825000000292,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.149101000000087,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a small repo (50 commits, 200 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 17.86923800000011,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3396.247339999998,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/status.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1861.9193654999835,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'all', Then measure tsgit > tsgit",
            "value": 1.7388110000000552,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'all', Then measure tsgit > tsgit",
            "value": 0.22027100000013888,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'change', Then measure tsgit > tsgit",
            "value": 1.7578790000000026,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'change', Then measure tsgit > tsgit",
            "value": 0.39138249999996333,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 1.7930275000001075,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'at-eol', Then measure tsgit > tsgit",
            "value": 0.3912874999998621,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given 5000 short lines, When digestNormalizedLine folds each line under mode 'none', Then measure tsgit > tsgit",
            "value": 1.735435999999936,
            "unit": "ms",
            "extra": "v24.19.0"
          },
          {
            "name": "test/bench/whitespace-digest.bench.ts > Given one 70,000-byte line, When digestNormalizedLine folds it under mode 'none', Then measure tsgit > tsgit",
            "value": 0.39137699999992037,
            "unit": "ms",
            "extra": "v24.19.0"
          }
        ]
      }
    ]
  }
}